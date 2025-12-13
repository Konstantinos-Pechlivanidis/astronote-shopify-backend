import { Router } from 'express';
import * as ctrl from '../controllers/campaigns.js';
import { validateBody, validateQuery } from '../middlewares/validation.js';
import {
  createCampaignSchema,
  updateCampaignSchema,
  listCampaignsQuerySchema,
  scheduleCampaignSchema,
} from '../schemas/campaigns.schema.js';
import {
  campaignsRateLimit,
  campaignSendRateLimit,
} from '../middlewares/rateLimits.js';
import {
  campaignsListCache,
  campaignMetricsCache,
  invalidateCampaignsCache,
} from '../middlewares/cache.js';

const r = Router();

// Apply rate limiting to all routes
r.use(campaignsRateLimit);

// GET /campaigns - List campaigns with filtering
r.get(
  '/',
  validateQuery(listCampaignsQuerySchema),
  campaignsListCache,
  ctrl.list,
);

// GET /campaigns/stats/summary - Get campaign statistics
r.get('/stats/summary', campaignsListCache, ctrl.stats);

// GET /campaigns/queue/stats - Get queue statistics (waiting, active, completed, failed)
r.get('/queue/stats', ctrl.getQueueStats);

// GET /campaigns/:id - Get single campaign
r.get('/:id', ctrl.getOne);

// POST /campaigns - Create new campaign
r.post(
  '/',
  validateBody(createCampaignSchema),
  invalidateCampaignsCache,
  ctrl.create,
);

// PUT /campaigns/:id - Update campaign
r.put(
  '/:id',
  validateBody(updateCampaignSchema),
  invalidateCampaignsCache,
  ctrl.update,
);

// DELETE /campaigns/:id - Delete campaign
r.delete('/:id', invalidateCampaignsCache, ctrl.remove);

// POST /campaigns/:id/prepare - Prepare campaign for sending
r.post('/:id/prepare', ctrl.prepare);

// POST /campaigns/:id/enqueue - Enqueue campaign for bulk SMS (new bulk SMS architecture)
r.post(
  '/:id/enqueue',
  campaignSendRateLimit,
  invalidateCampaignsCache,
  ctrl.enqueue,
);

// POST /campaigns/:id/send - Send campaign immediately (stricter rate limit)
// DEPRECATED: This endpoint is functionally identical to /enqueue
// Both call enqueueCampaign internally. Use /enqueue for consistency.
// Uses enqueueCampaign internally for bulk SMS
r.post(
  '/:id/send',
  campaignSendRateLimit,
  invalidateCampaignsCache,
  ctrl.sendNow,
);

// PUT /campaigns/:id/schedule - Schedule campaign
r.put(
  '/:id/schedule',
  validateBody(scheduleCampaignSchema),
  invalidateCampaignsCache,
  ctrl.schedule,
);

// POST /campaigns/:id/cancel - Cancel a campaign that is currently sending
r.post(
  '/:id/cancel',
  invalidateCampaignsCache,
  ctrl.cancel,
);

// GET /campaigns/:id/metrics - Get campaign metrics
r.get('/:id/metrics', campaignMetricsCache, ctrl.metrics);

// GET /campaigns/:id/status - Get campaign status with Phase 2.2 metrics
r.get('/:id/status', campaignMetricsCache, ctrl.status);

// GET /campaigns/:id/preview - Get campaign preview (recipient count, estimated cost)
r.get('/:id/preview', ctrl.getCampaignPreview);

// GET /campaigns/:id/progress - Get campaign progress (sent, failed, pending, percentage)
r.get('/:id/progress', campaignMetricsCache, ctrl.getCampaignProgress);

// GET /campaigns/:id/failed-recipients - Get failed recipients for a campaign
r.get('/:id/failed-recipients', ctrl.getFailedRecipients);

// POST /campaigns/:id/retry-failed - Retry failed SMS for a campaign
r.post('/:id/retry-failed', invalidateCampaignsCache, ctrl.retryFailed);

// POST /campaigns/:id/update-status - Manually trigger delivery status update
r.post(
  '/:id/update-status',
  invalidateCampaignsCache,
  ctrl.updateDeliveryStatus,
);

export default r;
