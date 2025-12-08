import prisma from './prisma.js';
import { logger } from '../utils/logger.js';
import { getMessageStatus, MittoApiError } from './mitto.js';

/**
 * Delivery Status Service
 * Handles updating message delivery statuses from Mitto API
 * and updating campaign statuses based on recipient statuses
 */

/**
 * Map Mitto deliveryStatus to our internal status
 * @param {string} mittoStatus - Mitto deliveryStatus value
 * @returns {string} Internal status ('sent', 'delivered', 'failed')
 */
export function mapMittoStatusToInternal(mittoStatus) {
  if (!mittoStatus) return 'sent'; // Default to sent if no status

  const status = mittoStatus.toLowerCase().trim();

  // Mitto statuses: Queued, Sent, Delivered, Failed, Failure
  if (status === 'delivered') {
    return 'delivered';
  }
  if (status === 'failed' || status === 'failure') {
    return 'failed';
  }
  if (status === 'sent' || status === 'queued') {
    return 'sent'; // Queued and Sent both map to 'sent' (message is in transit)
  }

  // Default to sent for unknown statuses
  logger.warn('Unknown Mitto deliveryStatus, defaulting to sent', {
    mittoStatus,
  });
  return 'sent';
}

/**
 * Update delivery status for a single message from Mitto
 * @param {string} mittoMessageId - Mitto message ID
 * @param {string} campaignId - Campaign ID (optional)
 * @returns {Promise<Object>} Updated status info
 */
export async function updateMessageDeliveryStatus(
  mittoMessageId,
  campaignId = null,
) {
  try {
    if (!mittoMessageId) {
      logger.warn('No Mitto message ID provided for status update');
      return null;
    }

    // Fetch status from Mitto
    const mittoStatus = await getMessageStatus(mittoMessageId);
    const internalStatus = mapMittoStatusToInternal(mittoStatus.deliveryStatus);

    logger.info('Updating message delivery status', {
      mittoMessageId,
      mittoStatus: mittoStatus.deliveryStatus,
      internalStatus,
      campaignId,
    });

    // Update CampaignRecipient if campaignId is provided
    if (campaignId) {
      const recipient = await prisma.campaignRecipient.findFirst({
        where: {
          campaignId,
          mittoMessageId,
        },
      });

      if (recipient) {
        const updateData = {
          deliveryStatus: mittoStatus.deliveryStatus,
        };

        const previousStatus = recipient.status;
        const previousDeliveryStatus = recipient.deliveryStatus;

        // Update recipient status based on delivery status
        if (internalStatus === 'delivered') {
          updateData.status = 'sent'; // Keep as 'sent' but mark as delivered
          updateData.deliveredAt = new Date();
        } else if (internalStatus === 'failed') {
          updateData.status = 'failed';
          updateData.error = `Delivery failed: ${mittoStatus.deliveryStatus}`;
        }
        // If status is 'sent', keep current status (might be 'sent' already)

        await prisma.campaignRecipient.update({
          where: { id: recipient.id },
          data: updateData,
        });

        // Update campaign metrics only if status changed
        if (
          internalStatus === 'delivered' &&
          previousDeliveryStatus !== 'Delivered' &&
          previousDeliveryStatus !== 'delivered'
        ) {
          // Only increment if this is the first time we're marking it as delivered
          await prisma.campaignMetrics.update({
            where: { campaignId },
            data: { totalDelivered: { increment: 1 } },
          });
        } else if (internalStatus === 'failed' && previousStatus !== 'failed') {
          // Only increment if status changed from non-failed to failed
          await prisma.campaignMetrics.update({
            where: { campaignId },
            data: { totalFailed: { increment: 1 } },
          });
        }
      }
    }

    // Update MessageLog
    const messageLog = await prisma.messageLog.findFirst({
      where: {
        providerMsgId: mittoMessageId,
      },
    });

    if (messageLog) {
      const updateData = {
        deliveryStatus: mittoStatus.deliveryStatus,
        status: internalStatus,
        updatedAt: new Date(),
      };

      await prisma.messageLog.update({
        where: { id: messageLog.id },
        data: updateData,
      });
    }

    return {
      mittoMessageId,
      mittoStatus: mittoStatus.deliveryStatus,
      internalStatus,
      updatedAt: mittoStatus.updatedAt,
    };
  } catch (error) {
    if (error instanceof MittoApiError) {
      logger.error('Failed to fetch message status from Mitto', {
        mittoMessageId,
        error: error.message,
        status: error.status,
      });
    } else {
      logger.error('Error updating message delivery status', {
        mittoMessageId,
        campaignId,
        error: error.message,
        stack: error.stack,
      });
    }
    throw error;
  }
}

/**
 * Update delivery statuses for all pending/sent recipients in a campaign
 * @param {string} campaignId - Campaign ID
 * @returns {Promise<Object>} Update summary
 */
export async function updateCampaignDeliveryStatuses(campaignId) {
  logger.info('Updating delivery statuses for campaign', { campaignId });

  // Get all recipients with Mitto message IDs that are not yet delivered or failed
  const recipients = await prisma.campaignRecipient.findMany({
    where: {
      campaignId,
      mittoMessageId: { not: null },
      status: { in: ['pending', 'sent'] }, // Only update pending/sent, skip already failed
    },
    select: {
      id: true,
      mittoMessageId: true,
      phoneE164: true,
      status: true,
      deliveryStatus: true,
    },
  });

  if (recipients.length === 0) {
    logger.info('No recipients to update for campaign', { campaignId });
    // Still update campaign status in case it needs to change
    await updateCampaignStatusFromRecipients(campaignId);
    return {
      campaignId,
      updated: 0,
      total: 0,
    };
  }

  // Filter out recipients that already have final statuses
  const recipientsToUpdate = recipients.filter(recipient => {
    const deliveryStatus = recipient.deliveryStatus?.toLowerCase();
    // Skip if already in final status
    return (
      !deliveryStatus ||
      (deliveryStatus !== 'delivered' &&
        deliveryStatus !== 'failed' &&
        deliveryStatus !== 'failure')
    );
  });

  if (recipientsToUpdate.length === 0) {
    logger.info('All recipients already have final delivery statuses', {
      campaignId,
    });
    // Still update campaign status in case it needs to change
    await updateCampaignStatusFromRecipients(campaignId);
    return {
      campaignId,
      updated: 0,
      total: recipients.length,
    };
  }

  logger.info('Found recipients to update', {
    campaignId,
    count: recipientsToUpdate.length,
    total: recipients.length,
  });

  // Update statuses in parallel (with rate limiting consideration)
  const updatePromises = recipientsToUpdate.map(recipient =>
    updateMessageDeliveryStatus(recipient.mittoMessageId, campaignId).catch(
      error => {
        logger.error('Failed to update recipient status', {
          campaignId,
          recipientId: recipient.id,
          mittoMessageId: recipient.mittoMessageId,
          error: error.message,
        });
        return null; // Return null on error to continue processing others
      },
    ),
  );

  const results = await Promise.allSettled(updatePromises);
  const successful = results.filter(
    r => r.status === 'fulfilled' && r.value !== null,
  ).length;

  logger.info('Campaign delivery status update completed', {
    campaignId,
    total: recipientsToUpdate.length,
    successful,
    failed: recipientsToUpdate.length - successful,
  });

  // Update campaign status based on recipient statuses
  await updateCampaignStatusFromRecipients(campaignId);

  return {
    campaignId,
    updated: successful,
    total: recipients.length,
    failed: recipients.length - successful,
  };
}

/**
 * Update campaign status based on recipient statuses
 * Rules:
 * - If all recipients are delivered/failed (no pending/sending), set to 'sent'
 * - If all recipients failed, set to 'failed'
 * - Otherwise, keep as 'sending'
 * @param {string} campaignId - Campaign ID
 * @returns {Promise<void>}
 */
export async function updateCampaignStatusFromRecipients(campaignId) {
  const campaign = await prisma.campaign.findFirst({
    where: { id: campaignId },
    include: {
      recipients: {
        select: {
          status: true,
          deliveryStatus: true,
        },
      },
    },
  });

  if (!campaign) {
    logger.warn('Campaign not found for status update', { campaignId });
    return;
  }

  // Only update if campaign is in 'sending' status
  if (campaign.status !== 'sending') {
    logger.debug('Campaign not in sending status, skipping status update', {
      campaignId,
      currentStatus: campaign.status,
    });
    return;
  }

  const recipients = campaign.recipients;
  if (recipients.length === 0) {
    logger.warn('Campaign has no recipients', { campaignId });
    return;
  }

  // Count recipients by status
  const statusCounts = {
    pending: 0,
    sent: 0,
    failed: 0,
  };

  recipients.forEach(recipient => {
    statusCounts[recipient.status] = (statusCounts[recipient.status] || 0) + 1;
  });

  const total = recipients.length;
  const pending = statusCounts.pending || 0;
  const sent = statusCounts.sent || 0;
  const failed = statusCounts.failed || 0;

  logger.info('Campaign recipient status summary', {
    campaignId,
    total,
    pending,
    sent,
    failed,
  });

  // Determine new campaign status
  let newStatus = campaign.status; // Default to current status

  // If no pending recipients, campaign is complete
  if (pending === 0) {
    // If all failed, mark campaign as failed
    if (failed === total) {
      newStatus = 'failed';
    } else {
      // At least some succeeded, mark as sent
      newStatus = 'sent';
    }
  }
  // If there are still pending recipients, keep as 'sending'

  // Only update if status changed
  if (newStatus !== campaign.status) {
    await prisma.campaign.update({
      where: { id: campaignId },
      data: { status: newStatus },
    });

    logger.info('Campaign status updated', {
      campaignId,
      oldStatus: campaign.status,
      newStatus,
      recipientSummary: { total, pending, sent, failed },
    });
  } else {
    logger.debug('Campaign status unchanged', {
      campaignId,
      status: campaign.status,
      recipientSummary: { total, pending, sent, failed },
    });
  }
}

/**
 * Update delivery statuses for all active campaigns
 * @param {number} limit - Maximum number of campaigns to process (default: 50)
 * @returns {Promise<Object>} Update summary
 */
export async function updateAllActiveCampaigns(limit = 50) {
  logger.info('Updating delivery statuses for all active campaigns', { limit });

  // Get all campaigns in 'sending' status
  const campaigns = await prisma.campaign.findMany({
    where: {
      status: 'sending',
    },
    select: {
      id: true,
      name: true,
      shopId: true,
    },
    take: limit,
    orderBy: {
      updatedAt: 'desc', // Process most recently updated first
    },
  });

  if (campaigns.length === 0) {
    logger.info('No active campaigns to update');
    return {
      processed: 0,
      updated: 0,
    };
  }

  logger.info('Found active campaigns to update', { count: campaigns.length });

  // Process campaigns in parallel
  const results = await Promise.allSettled(
    campaigns.map(campaign => updateCampaignDeliveryStatuses(campaign.id)),
  );

  const successful = results.filter(r => r.status === 'fulfilled').length;
  const failed = results.filter(r => r.status === 'rejected').length;

  logger.info('All active campaigns update completed', {
    total: campaigns.length,
    successful,
    failed,
  });

  return {
    processed: campaigns.length,
    successful,
    failed,
  };
}

export default {
  mapMittoStatusToInternal,
  updateMessageDeliveryStatus,
  updateCampaignDeliveryStatuses,
  updateCampaignStatusFromRecipients,
  updateAllActiveCampaigns,
};
