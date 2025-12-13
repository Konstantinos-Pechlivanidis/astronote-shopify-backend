import { getStoreId } from '../middlewares/store-resolution.js';
import { logger } from '../utils/logger.js';
import campaignsService from '../services/campaigns.js';
import { sendSuccess, sendCreated, sendPaginated } from '../utils/response.js';

/**
 * Campaigns Controller
 * Uses service layer for all campaign management logic
 */

/**
 * List campaigns with optional filtering
 * @route GET /campaigns
 */
export async function list(req, res, next) {
  try {
    const storeId = getStoreId(req);
    const filters = {
      page: req.query.page,
      pageSize: req.query.pageSize,
      status: req.query.status,
      sortBy: req.query.sortBy,
      sortOrder: req.query.sortOrder,
    };

    const result = await campaignsService.listCampaigns(storeId, filters);

    return sendPaginated(res, result.campaigns, result.pagination, {
      campaigns: result.campaigns, // Include for backward compatibility
    });
  } catch (error) {
    logger.error('List campaigns error', {
      error: error.message,
      stack: error.stack,
      storeId: getStoreId(req),
      query: req.query,
      requestId: req.id,
      path: req.path,
      method: req.method,
    });
    next(error);
  }
}

/**
 * Get a single campaign by ID
 * @route GET /campaigns/:id
 */
export async function getOne(req, res, next) {
  try {
    const storeId = getStoreId(req);
    const { id } = req.params;

    const campaign = await campaignsService.getCampaignById(storeId, id);

    return sendSuccess(res, campaign);
  } catch (error) {
    logger.error('Get campaign error', {
      error: error.message,
      stack: error.stack,
      storeId: getStoreId(req),
      campaignId: req.params.id,
      requestId: req.id,
      path: req.path,
      method: req.method,
    });
    next(error);
  }
}

/**
 * Create a new campaign
 * @route POST /campaigns
 */
export async function create(req, res, next) {
  try {
    const storeId = getStoreId(req);
    const campaignData = req.body;

    // Log the incoming data for debugging
    logger.info('Creating campaign request', {
      storeId,
      scheduleType: campaignData.scheduleType,
      hasScheduleAt: !!campaignData.scheduleAt,
    });

    const campaign = await campaignsService.createCampaign(
      storeId,
      campaignData,
    );

    return sendCreated(res, campaign, 'Campaign created successfully');
  } catch (error) {
    logger.error('Create campaign error', {
      error: error.message,
      stack: error.stack,
      storeId: getStoreId(req),
      body: req.body,
      scheduleType: req.body?.scheduleType,
      scheduleAt: req.body?.scheduleAt,
    });
    next(error);
  }
}

/**
 * Update a campaign
 * @route PUT /campaigns/:id
 */
export async function update(req, res, next) {
  try {
    const storeId = getStoreId(req);
    const { id } = req.params;
    const campaignData = req.body;

    const campaign = await campaignsService.updateCampaign(
      storeId,
      id,
      campaignData,
    );

    return sendSuccess(res, campaign, 'Campaign updated successfully');
  } catch (error) {
    logger.error('Update campaign error', {
      error: error.message,
      stack: error.stack,
      storeId: getStoreId(req),
      campaignId: req.params.id,
      requestId: req.id,
      path: req.path,
      method: req.method,
      body: req.body,
    });
    next(error);
  }
}

/**
 * Delete a campaign
 * @route DELETE /campaigns/:id
 */
export async function remove(req, res, next) {
  try {
    const storeId = getStoreId(req);
    const { id } = req.params;

    await campaignsService.deleteCampaign(storeId, id);

    return sendSuccess(res, null, 'Campaign deleted successfully');
  } catch (error) {
    logger.error('Delete campaign error', {
      error: error.message,
      stack: error.stack,
      storeId: getStoreId(req),
      campaignId: req.params.id,
      requestId: req.id,
      path: req.path,
      method: req.method,
    });
    next(error);
  }
}

/**
 * Prepare campaign for sending (validate recipients and credits)
 * @route POST /campaigns/:id/prepare
 */
export async function prepare(req, res, next) {
  try {
    const storeId = getStoreId(req);
    const { id } = req.params;

    const result = await campaignsService.prepareCampaign(storeId, id);

    return sendSuccess(res, result, 'Campaign prepared successfully');
  } catch (error) {
    logger.error('Prepare campaign error', {
      error: error.message,
      stack: error.stack,
      storeId: getStoreId(req),
      campaignId: req.params.id,
      requestId: req.id,
      path: req.path,
      method: req.method,
    });
    next(error);
  }
}

/**
 * Enqueue campaign for bulk SMS sending (new bulk SMS architecture)
 * @route POST /campaigns/:id/enqueue
 */
export async function enqueue(req, res, next) {
  try {
    const storeId = getStoreId(req);
    const { id } = req.params;
    const logger = (await import('../utils/logger.js')).logger;

    logger.info('Enqueue campaign request received', {
      storeId,
      campaignId: id,
      timestamp: new Date().toISOString(),
      requestId: req.id || req.headers['x-request-id'] || 'unknown',
    });

    const result = await campaignsService.enqueueCampaign(storeId, id);

    if (!result.ok) {
      // Map error reasons to appropriate HTTP status codes
      if (result.reason === 'not_found') {
        return res.status(404).json({
          ok: false,
          message: 'Campaign not found',
          code: 'NOT_FOUND',
        });
      }
      if (result.reason?.startsWith('invalid_status')) {
        return res.status(409).json({
          ok: false,
          message: 'Campaign cannot be sent in its current state',
          code: 'INVALID_STATUS',
          reason: result.reason,
        });
      }
      if (result.reason === 'no_recipients') {
        return res.status(400).json({
          ok: false,
          message: 'No recipients found for this campaign',
          code: 'NO_RECIPIENTS',
        });
      }
      if (result.reason === 'inactive_subscription') {
        return res.status(403).json({
          ok: false,
          message: 'Active subscription required to send SMS',
          code: 'INACTIVE_SUBSCRIPTION',
        });
      }
      if (result.reason === 'insufficient_credits') {
        return res.status(402).json({
          ok: false,
          message: result.message || 'Insufficient credits to send campaign',
          code: 'INSUFFICIENT_CREDITS',
          details: result.details || {},
        });
      }
      if (result.reason === 'no_recipients') {
        return res.status(400).json({
          ok: false,
          message: result.message || 'No recipients found for this campaign',
          code: 'NO_RECIPIENTS',
          details: result.details || {},
        });
      }
      if (result.reason === 'audience_resolution_failed') {
        return res.status(400).json({
          ok: false,
          message: result.message || 'Failed to resolve campaign audience',
          code: 'AUDIENCE_RESOLUTION_FAILED',
          details: result.details || {},
        });
      }
      return res.status(400).json({
        ok: false,
        message: result.message || result.reason || 'Campaign cannot be enqueued',
        code: 'ENQUEUE_FAILED',
        details: result.details || {},
      });
    }

    return res.json({
      ok: true,
      created: result.created,
      enqueuedJobs: result.enqueuedJobs,
      campaignId: result.campaignId,
    });
  } catch (error) {
    logger.error('Enqueue campaign error', {
      error: error.message,
      stack: error.stack,
      storeId: getStoreId(req),
      campaignId: req.params.id,
      requestId: req.id,
      path: req.path,
      method: req.method,
    });
    next(error);
  }
}

/**
 * Send campaign immediately (uses enqueueCampaign internally)
 * @route POST /campaigns/:id/send
 */
export async function sendNow(req, res, next) {
  try {
    const storeId = getStoreId(req);
    const { id } = req.params;

    // Use sendCampaign which internally calls enqueueCampaign
    const result = await campaignsService.sendCampaign(storeId, id);

    return sendSuccess(res, result, 'Campaign queued for sending');
  } catch (error) {
    logger.error('Send campaign error', {
      error: error.message,
      stack: error.stack,
      storeId: getStoreId(req),
      campaignId: req.params.id,
      requestId: req.id,
      path: req.path,
      method: req.method,
    });
    next(error);
  }
}

/**
 * Schedule campaign for later
 * @route PUT /campaigns/:id/schedule
 */
export async function schedule(req, res, next) {
  try {
    const storeId = getStoreId(req);
    const { id } = req.params;
    const scheduleData = req.body;

    const campaign = await campaignsService.scheduleCampaign(
      storeId,
      id,
      scheduleData,
    );

    return sendSuccess(res, campaign, 'Campaign scheduled successfully'); // ✅ Return campaign directly for test compatibility
  } catch (error) {
    logger.error('Schedule campaign error', {
      error: error.message,
      stack: error.stack,
      storeId: getStoreId(req),
      campaignId: req.params.id,
      requestId: req.id,
      path: req.path,
      method: req.method,
      body: req.body,
    });
    next(error);
  }
}

/**
 * Get queue statistics (waiting, active, completed, failed counts)
 * @route GET /campaigns/queue/stats
 */
export async function getQueueStats(req, res, next) {
  try {
    const { smsQueue } = await import('../queue/index.js');

    if (!smsQueue) {
      return res.status(503).json({
        ok: false,
        message: 'Queue service unavailable',
        code: 'QUEUE_UNAVAILABLE',
      });
    }

    // Get queue counts
    const [waiting, active, completed, delayedJobs, failed] = await Promise.all([
      smsQueue.getWaitingCount(),
      smsQueue.getActiveCount(),
      smsQueue.getCompletedCount(),
      smsQueue.getDelayed(),
      smsQueue.getFailedCount(),
    ]);
    const delayed = delayedJobs.length;

    // Get recent job activity (last 100 jobs)
    const [recentCompleted, recentFailed] = await Promise.all([
      smsQueue.getJobs(['completed'], 0, 99),
      smsQueue.getJobs(['failed'], 0, 99),
    ]);

    // Calculate processing rate (jobs completed in last hour)
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    const recentCompletedCount = recentCompleted.filter(
      job => job.finishedOn && job.finishedOn > oneHourAgo,
    ).length;

    return sendSuccess(res, {
      counts: {
        waiting,
        active,
        completed,
        delayed,
        failed,
        total: waiting + active + delayed,
      },
      processing: {
        jobsPerHour: recentCompletedCount,
        recentCompleted: recentCompleted.length,
        recentFailed: recentFailed.length,
      },
      health: {
        status: active > 0 || waiting > 0 ? 'processing' : 'idle',
        hasFailures: failed > 0,
      },
    });
  } catch (error) {
    logger.error('Get queue stats error', {
      error: error.message,
      stack: error.stack,
      requestId: req.id,
      path: req.path,
      method: req.method,
    });
    next(error);
  }
}

/**
 * Get campaign metrics
 * @route GET /campaigns/:id/metrics
 */
export async function metrics(req, res, next) {
  try {
    const storeId = getStoreId(req);
    const { id } = req.params;

    const metrics = await campaignsService.getCampaignMetrics(storeId, id);

    return sendSuccess(res, metrics);
  } catch (error) {
    logger.error('Get campaign metrics error', {
      error: error.message,
      stack: error.stack,
      storeId: getStoreId(req),
      campaignId: req.params.id,
      requestId: req.id,
      path: req.path,
      method: req.method,
    });
    next(error);
  }
}

/**
 * Get campaign preview (recipient count and estimated cost)
 * @route GET /campaigns/:id/preview
 */
export async function getCampaignPreview(req, res, next) {
  try {
    const storeId = getStoreId(req);
    const { id } = req.params;

    const result = await campaignsService.getCampaignPreview(storeId, id);

    if (!result.ok) {
      if (result.reason === 'not_found') {
        return res.status(404).json({
          ok: false,
          message: 'Campaign not found',
          code: 'NOT_FOUND',
        });
      }
      if (result.reason === 'inactive_subscription') {
        return res.status(403).json({
          ok: false,
          message: result.message || 'Active subscription required',
          code: 'INACTIVE_SUBSCRIPTION',
        });
      }
      if (result.reason === 'audience_resolution_failed') {
        return res.status(400).json({
          ok: false,
          message: result.message || 'Failed to resolve recipients',
          code: 'AUDIENCE_RESOLUTION_FAILED',
        });
      }
      return res.status(400).json({
        ok: false,
        message: result.message || 'Failed to get campaign preview',
        code: 'PREVIEW_FAILED',
      });
    }

    return sendSuccess(res, result);
  } catch (error) {
    logger.error('Get campaign preview error', {
      error: error.message,
      stack: error.stack,
      storeId: getStoreId(req),
      campaignId: req.params.id,
      requestId: req.id,
      path: req.path,
      method: req.method,
    });
    next(error);
  }
}

/**
 * Get campaign progress (sent, failed, pending counts and percentage)
 * @route GET /campaigns/:id/progress
 */
export async function getCampaignProgress(req, res, next) {
  try {
    const storeId = getStoreId(req);
    const { id } = req.params;

    const prisma = (await import('../services/prisma.js')).default;

    // Verify campaign belongs to store
    const campaign = await prisma.campaign.findFirst({
      where: { id, shopId: storeId },
      select: { id: true },
    });

    if (!campaign) {
      return res.status(404).json({
        ok: false,
        message: 'Campaign not found',
        code: 'NOT_FOUND',
      });
    }

    // Get recipient counts by status
    const [total, sent, failed, pending] = await Promise.all([
      prisma.campaignRecipient.count({
        where: { campaignId: id },
      }),
      prisma.campaignRecipient.count({
        where: { campaignId: id, status: 'sent' },
      }),
      prisma.campaignRecipient.count({
        where: { campaignId: id, status: 'failed' },
      }),
      prisma.campaignRecipient.count({
        where: { campaignId: id, status: 'pending' },
      }),
    ]);

    const processed = sent + failed;
    const progress = total > 0 ? Math.round((processed / total) * 100) : 0;

    return sendSuccess(res, {
      total,
      sent,
      failed,
      pending,
      processed,
      progress,
    });
  } catch (error) {
    logger.error('Get campaign progress error', {
      error: error.message,
      stack: error.stack,
      storeId: getStoreId(req),
      campaignId: req.params.id,
      requestId: req.id,
      path: req.path,
      method: req.method,
    });
    next(error);
  }
}

/**
 * Get failed recipients for a campaign
 * @route GET /campaigns/:id/failed-recipients
 */
export async function getFailedRecipients(req, res, next) {
  try {
    const storeId = getStoreId(req);
    const { id } = req.params;

    const prisma = (await import('../services/prisma.js')).default;

    // Verify campaign belongs to store
    const campaign = await prisma.campaign.findFirst({
      where: { id, shopId: storeId },
      select: { id: true },
    });

    if (!campaign) {
      return res.status(404).json({
        ok: false,
        message: 'Campaign not found',
        code: 'NOT_FOUND',
      });
    }

    // Get failed recipients with contact info
    const failedRecipients = await prisma.campaignRecipient.findMany({
      where: {
        campaignId: id,
        status: 'failed',
      },
      include: {
        contact: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            phoneE164: true,
            email: true,
          },
        },
      },
      orderBy: {
        updatedAt: 'desc',
      },
    });

    return sendSuccess(res, {
      campaignId: id,
      failedCount: failedRecipients.length,
      recipients: failedRecipients.map(r => ({
        id: r.id,
        phoneE164: r.phoneE164,
        error: r.error,
        failedAt: r.updatedAt,
        contact: r.contact
          ? {
            id: r.contact.id,
            firstName: r.contact.firstName,
            lastName: r.contact.lastName,
            email: r.contact.email,
          }
          : null,
      })),
    });
  } catch (error) {
    logger.error('Get failed recipients error', {
      error: error.message,
      stack: error.stack,
      storeId: getStoreId(req),
      campaignId: req.params.id,
      requestId: req.id,
      path: req.path,
      method: req.method,
    });
    next(error);
  }
}

/**
 * Get campaign status with Phase 2.2 metrics (queued, success, processed, failed)
 * @route GET /campaigns/:id/status
 */
export async function status(req, res, next) {
  try {
    const storeId = getStoreId(req);
    const { id } = req.params;

    // Get campaign with metrics
    const campaign = await campaignsService.getCampaignById(storeId, id);
    const metrics = await campaignsService.getCampaignMetrics(storeId, id);

    // Count queued recipients (status='pending')
    const prisma = (await import('../services/prisma.js')).default;
    const queuedCount = await prisma.campaignRecipient.count({
      where: {
        campaignId: id,
        status: 'pending',
      },
    });

    // Phase 2.2 metrics format
    const statusSummary = {
      campaign: {
        id: campaign.id,
        name: campaign.name,
        status: campaign.status,
        total: campaign.recipientCount || 0,
        sent: metrics.totalSent || 0,
        failed: metrics.totalFailed || 0,
        processed: metrics.totalProcessed || 0,
        createdAt: campaign.createdAt,
        updatedAt: campaign.updatedAt,
      },
      metrics: {
        queued: queuedCount,
        success: metrics.totalSent || 0, // Successfully sent (Phase 2.2)
        processed: metrics.totalProcessed || 0, // Processed (success + failed) (Phase 2.2)
        failed: metrics.totalFailed || 0, // Failed (Phase 2.2)
      },
    };

    return sendSuccess(res, statusSummary);
  } catch (error) {
    logger.error('Get campaign status error', {
      error: error.message,
      stack: error.stack,
      storeId: getStoreId(req),
      campaignId: req.params.id,
      requestId: req.id,
      path: req.path,
      method: req.method,
    });
    next(error);
  }
}

/**
 * Get campaign statistics
 * @route GET /campaigns/stats
 */
export async function stats(req, res, next) {
  try {
    const storeId = getStoreId(req);

    const stats = await campaignsService.getCampaignStats(storeId);

    return sendSuccess(res, stats);
  } catch (error) {
    logger.error('Get campaign stats error', {
      error: error.message,
      stack: error.stack,
      storeId: getStoreId(req),
      requestId: req.id,
      path: req.path,
      method: req.method,
    });
    next(error);
  }
}

/**
 * Cancel a campaign that is currently sending
 * @route POST /campaigns/:id/cancel
 */
export async function cancel(req, res, next) {
  try {
    const storeId = getStoreId(req);
    const { id } = req.params;

    const result = await campaignsService.cancelCampaign(storeId, id);

    if (!result.ok) {
      if (result.reason === 'not_found') {
        return res.status(404).json({
          ok: false,
          message: 'Campaign not found',
          code: 'NOT_FOUND',
        });
      }
      if (result.reason?.startsWith('invalid_status')) {
        return res.status(409).json({
          ok: false,
          message: result.message || 'Campaign cannot be cancelled in its current state',
          code: 'INVALID_STATUS',
          reason: result.reason,
        });
      }
      return res.status(400).json({
        ok: false,
        message: result.message || 'Campaign cannot be cancelled',
        code: 'CANCEL_FAILED',
      });
    }

    return sendSuccess(res, result, 'Campaign cancelled successfully');
  } catch (error) {
    logger.error('Cancel campaign error', {
      error: error.message,
      stack: error.stack,
      storeId: getStoreId(req),
      campaignId: req.params.id,
      requestId: req.id,
      path: req.path,
      method: req.method,
    });
    next(error);
  }
}

/**
 * Retry failed SMS for a campaign
 * @route POST /campaigns/:id/retry-failed
 */
export async function retryFailed(req, res, next) {
  try {
    const storeId = getStoreId(req);
    const { id } = req.params;

    const result = await campaignsService.retryFailedSms(storeId, id);

    return sendSuccess(res, result, 'Failed SMS queued for retry');
  } catch (error) {
    logger.error('Retry failed SMS error', {
      error: error.message,
      stack: error.stack,
      storeId: getStoreId(req),
      campaignId: req.params.id,
      requestId: req.id,
      path: req.path,
      method: req.method,
    });
    next(error);
  }
}

/**
 * Update delivery status for a campaign
 * @route POST /campaigns/:id/update-status
 */
export async function updateDeliveryStatus(req, res, next) {
  try {
    const { id } = req.params;

    const deliveryStatusService = await import(
      '../services/delivery-status.js'
    );
    const result =
      await deliveryStatusService.updateCampaignDeliveryStatuses(id);

    return sendSuccess(res, result, 'Delivery status updated successfully');
  } catch (error) {
    logger.error('Update delivery status error', {
      error: error.message,
      stack: error.stack,
      storeId: getStoreId(req),
      campaignId: req.params.id,
      requestId: req.id,
      path: req.path,
      method: req.method,
    });
    next(error);
  }
}

export default {
  list,
  getOne,
  create,
  update,
  remove,
  prepare,
  enqueue,
  sendNow,
  schedule,
  cancel,
  metrics,
  status,
  stats,
  retryFailed,
  updateDeliveryStatus,
  getCampaignPreview,
  getCampaignProgress,
  getQueueStats,
  getFailedRecipients,
};
