import { logger } from '../utils/logger.js';
import { allCampaignsStatusQueue, campaignQueue } from '../queue/index.js';
import prisma from './prisma.js';
import { processDailyBirthdayAutomations } from './automations.js';
import { CampaignStatus } from '../utils/prismaEnums.js';

/**
 * Scheduler Service
 * Handles periodic tasks like updating delivery statuses and executing scheduled campaigns
 */

/**
 * Check for due scheduled campaigns and queue them for execution
 * This should be called periodically (e.g., every minute)
 */
export async function processScheduledCampaigns() {
  try {
    const now = new Date();

    // Find all campaigns that are scheduled and due to be sent
    const dueCampaigns = await prisma.campaign.findMany({
      where: {
        status: CampaignStatus.scheduled,
        scheduleAt: {
          lte: now, // scheduleAt is in UTC, so we compare with UTC now
        },
      },
      select: {
        id: true,
        shopId: true,
        name: true,
        scheduleAt: true,
      },
      take: 50, // Process up to 50 campaigns per run to avoid overload
    });

    if (dueCampaigns.length === 0) {
      return { processed: 0, queued: 0 };
    }

    logger.info('Found due scheduled campaigns', {
      count: dueCampaigns.length,
      campaignIds: dueCampaigns.map(c => c.id),
    });

    let queued = 0;
    let errors = 0;

    // Queue each due campaign for execution
    for (const campaign of dueCampaigns) {
      try {
        // Use a transaction to update status and queue the job atomically
        // This prevents the same campaign from being queued multiple times
        await prisma.$transaction(async tx => {
          // Re-check the campaign status to ensure it's still 'scheduled'
          // This prevents race conditions if the campaign was already processed
          const currentCampaign = await tx.campaign.findUnique({
            where: { id: campaign.id },
            select: { id: true, status: true },
          });

          if (!currentCampaign || currentCampaign.status !== CampaignStatus.scheduled) {
            logger.warn('Campaign status changed before queuing, skipping', {
              campaignId: campaign.id,
              currentStatus: currentCampaign?.status,
            });
            return; // Skip this campaign
          }

          // Update status to 'sending' to prevent duplicate queuing
          // The worker will handle the actual sending
          await tx.campaign.update({
            where: { id: campaign.id },
            data: { status: CampaignStatus.sending },
          });
        });

        // Queue the campaign job
        await campaignQueue.add(
          'campaign-send',
          {
            storeId: campaign.shopId,
            campaignId: campaign.id,
          },
          {
            jobId: `campaign-send-${campaign.id}`, // Use campaign ID only to prevent duplicates
            removeOnComplete: true,
            attempts: 3, // Retry up to 3 times if execution fails
            backoff: {
              type: 'exponential',
              delay: 5000, // 5s, 10s, 20s
            },
          },
        );

        queued++;
        logger.info('Queued scheduled campaign for execution', {
          campaignId: campaign.id,
          shopId: campaign.shopId,
          campaignName: campaign.name,
          scheduleAt: campaign.scheduleAt?.toISOString(),
        });
      } catch (error) {
        errors++;
        logger.error('Failed to queue scheduled campaign', {
          campaignId: campaign.id,
          shopId: campaign.shopId,
          error: error.message,
          stack: error.stack,
        });

        // If queuing failed but status was updated, revert it
        try {
          await prisma.campaign.update({
            where: { id: campaign.id },
            data: { status: 'scheduled' },
          });
        } catch (revertError) {
          logger.error('Failed to revert campaign status after queuing error', {
            campaignId: campaign.id,
            error: revertError.message,
          });
        }
      }
    }

    logger.info('Scheduled campaigns processing completed', {
      found: dueCampaigns.length,
      queued,
      errors,
    });

    return { processed: dueCampaigns.length, queued, errors };
  } catch (error) {
    logger.error('Error processing scheduled campaigns', {
      error: error.message,
      stack: error.stack,
    });
    throw error;
  }
}

/**
 * Acquire distributed lock for scheduler to prevent multiple instances from running simultaneously
 * Uses Redis to ensure only one instance can process scheduled jobs at a time
 * @param {string} lockType - Type of lock (e.g., 'campaigns', 'status-updates', 'birthdays')
 * @returns {Promise<boolean>} True if lock was acquired
 */
async function acquireSchedulerLock(lockType = 'campaigns') {
  try {
    const { queueRedis } = await import('../config/redis.js');
    const lockKey = `scheduler:lock:${lockType}`;
    const lockTTL = lockType === 'campaigns' ? 90 : 330; // campaigns: 90s, others: 330s (5.5 min)
    const lockValue = `${process.pid}-${Date.now()}`; // Unique value per instance

    // Try to acquire lock (NX = only if not exists)
    const acquired = await queueRedis.set(lockKey, lockValue, 'EX', lockTTL, 'NX');

    if (acquired === 'OK') {
      logger.debug('Scheduler lock acquired', { lockType, lockValue, ttl: lockTTL });
      return true;
    }

    logger.debug('Scheduler lock not acquired - another instance is processing', { lockType });
    return false;
  } catch (error) {
    logger.error('Failed to acquire scheduler lock', { lockType, error: error.message });
    // On error, allow processing (fail-open to prevent deadlock)
    return true;
  }
}

/**
 * Start periodic processing of scheduled campaigns
 * This should be called on application startup
 */
export function startScheduledCampaignsProcessor() {
  // CRITICAL: Check if scheduler should run on this instance
  // Set RUN_SCHEDULER=false in production to disable on worker instances
  if (process.env.RUN_SCHEDULER === 'false') {
    logger.info('Scheduled campaigns processor disabled (RUN_SCHEDULER=false)');
    return;
  }

  // Skip in test mode
  if (process.env.NODE_ENV === 'test' && process.env.SKIP_QUEUES === 'true') {
    logger.info('Skipping scheduled campaigns processor in test mode');
    return;
  }

  // Check for due campaigns every minute
  const INTERVAL_MS = 60 * 1000; // 1 minute

  // Initial delay of 30 seconds to let the app fully start
  setTimeout(() => {
    processNextBatch();
  }, 30000); // 30 seconds

  function processNextBatch() {
    // Use Redis lock to prevent multiple instances from processing simultaneously
    acquireSchedulerLock()
      .then(hasLock => {
        if (!hasLock) {
          // Another instance is processing, skip this round
          logger.debug('Skipping scheduler run - another instance has the lock');
          setTimeout(processNextBatch, INTERVAL_MS);
          return;
        }

        // We have the lock, process scheduled campaigns
      processScheduledCampaigns()
        .then(result => {
          if (result.queued > 0) {
            logger.info('Scheduled campaigns processed', result);
          }
        })
        .catch(error => {
          logger.error('Error in scheduled campaigns processor', {
            error: error.message,
          });
          })
          .finally(() => {
            // Schedule next check after processing completes
            setTimeout(processNextBatch, INTERVAL_MS);
          });
      })
      .catch(error => {
        logger.error('Failed to acquire scheduler lock', {
          error: error.message,
        });
        // Retry after interval even if lock acquisition failed
      setTimeout(processNextBatch, INTERVAL_MS);
      });
  }

  logger.info('Scheduled campaigns processor started with distributed lock', {
    interval: `${INTERVAL_MS / 1000}s`,
    runScheduler: process.env.RUN_SCHEDULER || 'true (default)',
  });
}

/**
 * Schedule periodic delivery status updates
 * This should be called on application startup
 */
export function startPeriodicStatusUpdates() {
  // CRITICAL: Check if scheduler should run on this instance
  if (process.env.RUN_SCHEDULER === 'false') {
    logger.info('Periodic status updates disabled (RUN_SCHEDULER=false)');
    return;
  }

  // Skip in test mode
  if (process.env.NODE_ENV === 'test' && process.env.SKIP_QUEUES === 'true') {
    logger.info('Skipping periodic status updates in test mode');
    return;
  }

  // Schedule periodic updates every 5 minutes
  const INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

  // Initial delay of 1 minute to let the app fully start
  setTimeout(() => {
    scheduleNextUpdate();
  }, 60000); // 1 minute

  async function scheduleNextUpdate() {
    // Use Redis lock to prevent multiple instances from scheduling simultaneously
    const hasLock = await acquireSchedulerLock('status-updates');

    if (!hasLock) {
      logger.debug('Skipping status update - another instance has the lock');
      setTimeout(scheduleNextUpdate, INTERVAL_MS);
      return;
    }

    try {
      // Add job to queue
      await allCampaignsStatusQueue.add(
        'update-all-campaigns-status',
        {},
        {
          jobId: `periodic-status-update-${Date.now()}`,
          removeOnComplete: true,
        },
      );

      logger.info('Scheduled periodic delivery status update');

      // Schedule next update
      setTimeout(scheduleNextUpdate, INTERVAL_MS);
    } catch (error) {
      logger.error('Failed to schedule periodic status update', {
        error: error.message,
      });
      // Retry after 1 minute if scheduling fails
      setTimeout(scheduleNextUpdate, 60000);
    }
  }

  logger.info('Periodic delivery status updates started with distributed lock', {
    interval: `${INTERVAL_MS / 1000}s`,
  });
}

/**
 * Start daily birthday automation scheduler
 * Runs once per day at midnight UTC (or configurable time)
 * This should be called on application startup
 */
export function startBirthdayAutomationScheduler() {
  // CRITICAL: Check if scheduler should run on this instance
  if (process.env.RUN_SCHEDULER === 'false') {
    logger.info('Birthday automation scheduler disabled (RUN_SCHEDULER=false)');
    return;
  }

  // Skip in test mode
  if (process.env.NODE_ENV === 'test' && process.env.SKIP_QUEUES === 'true') {
    logger.info('Skipping birthday automation scheduler in test mode');
    return;
  }

  // Calculate time until next midnight UTC
  function getTimeUntilMidnight() {
    const now = new Date();
    const midnight = new Date(now);
    midnight.setUTCHours(24, 0, 0, 0); // Next midnight UTC
    return midnight.getTime() - now.getTime();
  }

  async function scheduleNextRun() {
    const timeUntilMidnight = getTimeUntilMidnight();

    setTimeout(async () => {
      // Use Redis lock to prevent multiple instances from processing simultaneously
      const hasLock = await acquireSchedulerLock('birthdays');

      if (!hasLock) {
        logger.debug('Skipping birthday automation - another instance has the lock');
        scheduleNextRun();
        return;
      }

      processDailyBirthdayAutomations()
        .then(result => {
          logger.info('Daily birthday automation check completed', {
            total: result.total,
            sent: result.sent,
            skipped: result.skipped,
            failed: result.failed,
          });
        })
        .catch(error => {
          logger.error('Error in daily birthday automation check', {
            error: error.message,
            stack: error.stack,
          });
        })
        .finally(() => {
          // Schedule next run (24 hours from now)
          scheduleNextRun();
        });
    }, timeUntilMidnight);
  }

  // Initial delay: wait until next midnight, or run immediately if within 1 hour of midnight
  const timeUntilMidnight = getTimeUntilMidnight();
  const oneHour = 60 * 60 * 1000;

  if (timeUntilMidnight < oneHour) {
    // Run immediately if we're close to midnight
    logger.info(
      'Running birthday automation check immediately (close to midnight)',
    );
    processDailyBirthdayAutomations()
      .then(result => {
        logger.info('Initial birthday automation check completed', result);
      })
      .catch(error => {
        logger.error('Error in initial birthday automation check', {
          error: error.message,
        });
      });
    // Then schedule for next midnight (24 hours from now)
    setTimeout(scheduleNextRun, 24 * 60 * 60 * 1000);
  } else {
    // Schedule for next midnight
    scheduleNextRun();
  }

  logger.info('Birthday automation scheduler started', {
    nextRun: 'midnight UTC',
  });
}

export default {
  startPeriodicStatusUpdates,
  startScheduledCampaignsProcessor,
  processScheduledCampaigns,
  startBirthdayAutomationScheduler,
};
