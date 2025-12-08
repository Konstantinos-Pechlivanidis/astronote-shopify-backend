import { logger } from '../../utils/logger.js';
import { sendCampaign } from '../../services/campaigns.js';

/**
 * Execute a scheduled campaign
 * @param {Object} job - BullMQ job
 * @param {string} job.data.storeId - Store ID
 * @param {string} job.data.campaignId - Campaign ID to send
 */
export async function handleCampaignSend(job) {
  const { storeId, campaignId } = job.data;

  try {
    logger.info('Processing campaign send job', {
      jobId: job.id,
      storeId,
      campaignId,
    });

    // Verify campaign exists and is in correct state
    const prisma = (await import('../../services/prisma.js')).default;
    const campaign = await prisma.campaign.findUnique({
      where: { id: campaignId },
      select: { id: true, status: true, shopId: true },
    });

    if (!campaign) {
      throw new Error(`Campaign ${campaignId} not found`);
    }

    if (campaign.shopId !== storeId) {
      throw new Error(
        `Campaign ${campaignId} does not belong to store ${storeId}`,
      );
    }

    // Campaign should be in 'sending' status (set by scheduler) or 'scheduled' (if retrying)
    if (campaign.status !== 'sending' && campaign.status !== 'scheduled') {
      logger.warn('Campaign is not in expected status, skipping', {
        campaignId,
        status: campaign.status,
      });
      return {
        status: 'skipped',
        reason: 'invalid_status',
        campaignStatus: campaign.status,
      };
    }

    const result = await sendCampaign(storeId, campaignId);

    logger.info('Campaign send job completed', {
      jobId: job.id,
      storeId,
      campaignId,
      recipientCount: result.recipientCount,
      status: result.status,
    });

    return result;
  } catch (error) {
    logger.error('Campaign send job failed', {
      jobId: job.id,
      storeId,
      campaignId,
      error: error.message,
      stack: error.stack,
    });

    // Revert status to 'scheduled' if send failed, so it can be retried
    try {
      const prisma = (await import('../../services/prisma.js')).default;
      await prisma.campaign.update({
        where: { id: campaignId },
        data: { status: 'scheduled' },
      });
      logger.info('Reverted campaign status to scheduled after failure', {
        campaignId,
      });
    } catch (revertError) {
      logger.error('Failed to revert campaign status after send failure', {
        campaignId,
        error: revertError.message,
      });
    }

    throw error;
  }
}
