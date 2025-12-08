import { logger } from '../../utils/logger.js';
import {
  updateCampaignDeliveryStatuses,
  updateAllActiveCampaigns,
} from '../../services/delivery-status.js';

/**
 * Update delivery status for a specific campaign
 * @param {Object} job - BullMQ job
 * @param {string} job.data.campaignId - Campaign ID to update
 */
export async function handleCampaignStatusUpdate(job) {
  const { campaignId } = job.data;

  try {
    logger.info('Processing campaign status update job', {
      jobId: job.id,
      campaignId,
    });

    const result = await updateCampaignDeliveryStatuses(campaignId);

    logger.info('Campaign status update job completed', {
      jobId: job.id,
      campaignId,
      result,
    });

    return result;
  } catch (error) {
    logger.error('Campaign status update job failed', {
      jobId: job.id,
      campaignId,
      error: error.message,
      stack: error.stack,
    });
    throw error;
  }
}

/**
 * Update delivery statuses for all active campaigns
 * @param {Object} job - BullMQ job
 */
export async function handleAllCampaignsStatusUpdate(job) {
  try {
    logger.info('Processing all campaigns status update job', {
      jobId: job.id,
    });

    const result = await updateAllActiveCampaigns(50); // Process up to 50 campaigns per run

    logger.info('All campaigns status update job completed', {
      jobId: job.id,
      result,
    });

    return result;
  } catch (error) {
    logger.error('All campaigns status update job failed', {
      jobId: job.id,
      error: error.message,
      stack: error.stack,
    });
    throw error;
  }
}

export default {
  handleCampaignStatusUpdate,
  handleAllCampaignsStatusUpdate,
};
