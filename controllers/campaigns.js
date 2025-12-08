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
 * Send campaign immediately
 * @route POST /campaigns/:id/send
 */
export async function sendNow(req, res, next) {
  try {
    const storeId = getStoreId(req);
    const { id } = req.params;

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
  sendNow,
  schedule,
  metrics,
  stats,
  retryFailed,
  updateDeliveryStatus,
};
