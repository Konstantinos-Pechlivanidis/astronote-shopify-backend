import { Worker } from 'bullmq';
import { queueRedis } from '../config/redis.js';
import { handleMittoSend } from './jobs/mittoSend.js';
import { handleBulkSMS } from './jobs/bulkSms.js';
import {
  handleCampaignStatusUpdate,
  handleAllCampaignsStatusUpdate,
} from './jobs/deliveryStatusUpdate.js';
import { handleCampaignSend } from './jobs/campaignSend.js';
import {
  handleAbandonedCartTrigger,
  handleOrderConfirmationTrigger,
  handleOrderFulfilledTrigger,
  handleCustomerReengagementTrigger,
  handleBirthdayTrigger,
  handleWelcomeTrigger,
} from './jobs/automationTriggers.js';
import { logger } from '../utils/logger.js';

// Skip workers in test mode for faster tests
const skipWorkers =
  process.env.NODE_ENV === 'test' && process.env.SKIP_QUEUES === 'true';

// Mock Worker class for tests
class MockWorker {
  constructor(name, processor, options) {
    this.name = name;
    this.processor = processor;
    this.options = options;
  }
  async close() {
    return Promise.resolve();
  }
  on() {
    return this;
  }
  once() {
    return this;
  }
}

// SMS Worker
// Optimized for high-volume SMS sending (500k+ SMS/day)
// Concurrency and rate limits adjusted for Black Friday peak loads
// Handles both individual SMS (sendSMS) and bulk SMS (sendBulkSMS) jobs
export const smsWorker = skipWorkers
  ? new MockWorker('sms-send', () => {}, {})
  : new Worker(
    'sms-send',
    async job => {
      logger.info(`Processing SMS job ${job.id}`, { jobData: job.data, jobName: job.name });

      // Route to appropriate handler based on job name
      if (job.name === 'sendBulkSMS') {
        // Campaigns always use bulk SMS (sendBulkSMS job type)
        return await handleBulkSMS(job);
      } else if (job.name === 'sendSMS' || !job.name) {
        // Individual jobs (sendSMS) are only for automations and test messages
        return await handleMittoSend(job);
      } else {
        logger.warn({ jobId: job.id, jobName: job.name }, 'Unknown SMS job type, skipping');
        return { ok: false, reason: 'Unknown job type' };
      }
    },
    {
      connection: queueRedis,
      concurrency: 200, // Increased from 50 to handle 500k+ SMS campaigns
      removeOnComplete: 1000, // Keep more completed jobs for monitoring
      removeOnFail: 500, // Keep more failed jobs for analysis
      limiter: {
        max: 500, // Max 500 jobs per duration (increased from 100)
        // Note: Verify with Mitto support for enterprise rate limits
        // Standard accounts: 100-200 SMS/second
        // Enterprise accounts: 500-1000 SMS/second (contact Mitto)
        duration: 1000, // Per second
      },
    },
  );

// Campaign Worker
export const campaignWorker = skipWorkers
  ? new MockWorker('campaign-send', () => {}, {})
  : new Worker(
    'campaign-send',
    async job => {
      return await handleCampaignSend(job);
    },
    {
      connection: queueRedis,
      concurrency: 5,
      removeOnComplete: 50,
      removeOnFail: 25,
    },
  );

// Automation Worker
export const automationWorker = skipWorkers
  ? new MockWorker('automation-trigger', () => {}, {})
  : new Worker(
    'automation-trigger',
    async job => {
      logger.info(`Processing automation job ${job.id}`, {
        jobData: job.data,
        jobName: job.name,
      });

      // Route to appropriate handler based on job name
      try {
        switch (job.name) {
        case 'order-confirmation':
          return await handleOrderConfirmationTrigger(job);
        case 'order-fulfilled':
          return await handleOrderFulfilledTrigger(job);
        case 'abandoned-cart':
          return await handleAbandonedCartTrigger(job);
        case 'customer-reengagement':
          return await handleCustomerReengagementTrigger(job);
        case 'birthday':
          return await handleBirthdayTrigger(job);
        case 'welcome':
          return await handleWelcomeTrigger(job);
        default:
          logger.warn('Unknown automation job type', {
            jobId: job.id,
            jobName: job.name,
          });
          return { success: false, reason: 'Unknown job type' };
        }
      } catch (error) {
        logger.error('Automation job processing failed', {
          jobId: job.id,
          jobName: job.name,
          error: error.message,
          stack: error.stack,
        });
        throw error; // Re-throw to trigger retry mechanism
      }
    },
    {
      connection: queueRedis,
      concurrency: 10,
      removeOnComplete: 200,
      removeOnFail: 100,
    },
  );

// Delivery Status Update Worker
export const deliveryStatusWorker = skipWorkers
  ? new MockWorker('delivery-status-update', () => {}, {})
  : new Worker(
    'delivery-status-update',
    async job => {
      logger.info(`Processing delivery status update job ${job.id}`, {
        jobData: job.data,
        jobName: job.name,
      });
      // Handle both single campaign update and all campaigns update based on job name
      if (job.name === 'update-campaign-status') {
        return await handleCampaignStatusUpdate(job);
      } else if (job.name === 'update-all-campaigns-status') {
        return await handleAllCampaignsStatusUpdate(job);
      }
      // Default to single campaign update for backward compatibility
      return await handleCampaignStatusUpdate(job);
    },
    {
      connection: queueRedis,
      concurrency: 5, // Lower concurrency to avoid rate limiting Mitto API
      removeOnComplete: 100,
      removeOnFail: 50,
    },
  );

// All Campaigns Status Update Worker (for periodic polling)
export const allCampaignsStatusWorker = skipWorkers
  ? new MockWorker('all-campaigns-status-update', () => {}, {})
  : new Worker(
    'all-campaigns-status-update',
    async job => {
      logger.info(`Processing all campaigns status update job ${job.id}`, {
        jobData: job.data,
      });
      return await handleAllCampaignsStatusUpdate(job);
    },
    {
      connection: queueRedis,
      concurrency: 1, // Single concurrent job for periodic updates
      removeOnComplete: 10,
      removeOnFail: 5,
    },
  );

// Event handlers for SMS Worker
smsWorker.on('completed', job => {
  logger.info(`SMS job completed: ${job.id}`, {
    duration: job.processedOn - job.timestamp,
  });
});

smsWorker.on('failed', (job, err) => {
  logger.error(`SMS job failed: ${job?.id}`, {
    error: err.message,
    attempts: job.attemptsMade,
  });
});

smsWorker.on('stalled', job => {
  logger.warn(`SMS job stalled: ${job.id}`);
});

// Event handlers for Campaign Worker
campaignWorker.on('completed', job => {
  logger.info(`Campaign job completed: ${job.id}`, {
    duration: job.processedOn - job.timestamp,
  });
});

campaignWorker.on('failed', (job, err) => {
  logger.error(`Campaign job failed: ${job?.id}`, {
    error: err.message,
    attempts: job.attemptsMade,
  });
});

// Event handlers for Automation Worker
automationWorker.on('completed', job => {
  logger.info(`Automation job completed: ${job.id}`, {
    duration: job.processedOn - job.timestamp,
  });
});

automationWorker.on('failed', (job, err) => {
  logger.error(`Automation job failed: ${job?.id}`, {
    error: err.message,
    attempts: job.attemptsMade,
  });
});

// Event handlers for Delivery Status Worker
deliveryStatusWorker.on('completed', job => {
  logger.info(`Delivery status update job completed: ${job.id}`, {
    duration: job.processedOn - job.timestamp,
  });
});

deliveryStatusWorker.on('failed', (job, err) => {
  logger.error(`Delivery status update job failed: ${job?.id}`, {
    error: err.message,
    attempts: job.attemptsMade,
  });
});

// Event handlers for All Campaigns Status Worker
allCampaignsStatusWorker.on('completed', job => {
  logger.info(`All campaigns status update job completed: ${job.id}`, {
    duration: job.processedOn - job.timestamp,
  });
});

allCampaignsStatusWorker.on('failed', (job, err) => {
  logger.error(`All campaigns status update job failed: ${job?.id}`, {
    error: err.message,
    attempts: job.attemptsMade,
  });
});

// Graceful shutdown
const gracefulShutdown = async () => {
  logger.info('Shutting down workers gracefully...');

  await Promise.all([
    smsWorker.close(),
    campaignWorker.close(),
    automationWorker.close(),
    deliveryStatusWorker.close(),
    allCampaignsStatusWorker.close(),
  ]);

  logger.info('All workers shut down');
  process.exit(0);
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

logger.info('Workers started successfully');
