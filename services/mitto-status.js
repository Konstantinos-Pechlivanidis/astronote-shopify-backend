// services/mitto-status.js
// On-demand status refresh from Mitto API (for debugging/UI)

import prisma from './prisma.js';
import { logger } from '../utils/logger.js';
import { getMessageStatus, MittoApiError } from './mitto.js';
import { updateCampaignAggregates } from './campaignAggregates.js';

/**
 * Map Mitto deliveryStatus to our internal status (Phase 2.2)
 * Mitto sends: "Sent", "Delivered", "Failure"
 * We only use "sent" and "failed" - map "Delivered" to "sent"
 */
function mapMittoStatusToInternal(mittoStatus) {
  if (!mittoStatus) return 'sent'; // Default to sent if no status

  const status = String(mittoStatus).toLowerCase().trim();

  // Mitto statuses: Queued, Sent, Delivered, Failed, Failure
  if (status === 'delivered' || status === 'delivrd' || status === 'completed' || status === 'ok') {
    return 'sent'; // Map delivered to sent (Phase 2.2)
  }
  if (status === 'failed' || status === 'failure' || status === 'undelivered' || status === 'expired' || status === 'rejected' || status === 'error') {
    return 'failed';
  }
  if (status === 'sent' || status === 'queued' || status === 'accepted' || status === 'submitted' || status === 'enroute') {
    return 'sent';
  }

  // Default to sent for unknown statuses
  logger.warn('Unknown Mitto deliveryStatus, defaulting to sent', {
    mittoStatus,
  });
  return 'sent';
}

/**
 * Refresh message status from Mitto API (on-demand)
 * Updates CampaignRecipient and MessageLog records
 *
 * @param {string} providerMessageId - Mitto message ID
 * @param {string} shopId - Shop ID for scoping (optional, for security)
 * @returns {Promise<Object>} Refresh result
 */
export async function refreshMessageStatus(providerMessageId, shopId = null) {
  if (!providerMessageId) {
    throw new Error('providerMessageId is required');
  }

  logger.info({ providerMessageId, shopId }, 'Refreshing message status from Mitto');

  try {
    // Fetch status from Mitto API
    const mittoStatus = await getMessageStatus(providerMessageId);
    const internalStatus = mapMittoStatusToInternal(mittoStatus.deliveryStatus);

    logger.info('Mitto status retrieved', {
      providerMessageId,
      mittoStatus: mittoStatus.deliveryStatus,
      internalStatus,
    });

    // Find CampaignRecipient by providerMessageId
    const where = { mittoMessageId: providerMessageId };
    if (shopId) {
      // If shopId provided, verify through campaign relationship
      where.campaign = { shopId };
    }

    const recipient = await prisma.campaignRecipient.findFirst({
      where,
      include: {
        campaign: {
          select: { id: true, shopId: true },
        },
      },
    });

    let updatedRecipient = false;
    let updatedLog = false;
    const affectedCampaignIds = new Set();

    // Update CampaignRecipient if found
    if (recipient) {
      const updateData = {
        deliveryStatus: mittoStatus.deliveryStatus,
        updatedAt: new Date(),
      };

      if (internalStatus === 'sent') {
        updateData.status = 'sent';
        if (!recipient.sentAt) {
          updateData.sentAt = new Date();
        }
        updateData.deliveredAt = new Date();
        updateData.error = null;
      } else if (internalStatus === 'failed') {
        updateData.status = 'failed';
        updateData.error = `Mitto status: ${mittoStatus.deliveryStatus}`;
      }

      await prisma.campaignRecipient.update({
        where: { id: recipient.id },
        data: updateData,
      });

      updatedRecipient = true;
      affectedCampaignIds.add(recipient.campaignId);
    }

    // Also update MessageLog if exists
    const logWhere = { providerMsgId: providerMessageId };
    if (shopId) {
      logWhere.shopId = shopId;
    }

    const log = await prisma.messageLog.findFirst({
      where: logWhere,
    });

    if (log) {
      await prisma.messageLog.update({
        where: { id: log.id },
        data: {
          deliveryStatus: mittoStatus.deliveryStatus,
          status: internalStatus === 'sent' ? 'sent' : 'failed',
          updatedAt: new Date(),
        },
      });

      updatedLog = true;
      if (log.campaignId) {
        affectedCampaignIds.add(log.campaignId);
      }
    }

    // Update campaign aggregates for affected campaigns (non-blocking)
    if (affectedCampaignIds.size > 0) {
      const updatePromises = Array.from(affectedCampaignIds).map(async (campaignId) => {
        try {
          const campaign = await prisma.campaign.findUnique({
            where: { id: campaignId },
            select: { shopId: true },
          });
          if (campaign) {
            await updateCampaignAggregates(campaignId, campaign.shopId);
          }
        } catch (aggErr) {
          logger.warn('Failed to update campaign aggregates after status refresh', {
            campaignId,
            err: aggErr.message,
          });
        }
      });

      // Fire and forget
      Promise.all(updatePromises).catch((err) => {
        logger.error('Error updating campaign aggregates after status refresh', {
          err: err.message,
        });
      });
    }

    if (!updatedRecipient && !updatedLog) {
      logger.warn('No local records found for Mitto messageId', {
        providerMessageId,
        shopId,
      });
      return {
        updated: 0,
        status: mittoStatus,
        internalStatus,
        message: 'No local records found',
      };
    }

    logger.info('Message status refreshed successfully', {
      providerMessageId,
      updatedRecipient,
      updatedLog,
      internalStatus,
      affectedCampaigns: affectedCampaignIds.size,
    });

    return {
      updated: (updatedRecipient ? 1 : 0) + (updatedLog ? 1 : 0),
      status: mittoStatus,
      internalStatus,
      affectedCampaignIds: Array.from(affectedCampaignIds),
    };
  } catch (err) {
    if (err instanceof MittoApiError && err.status === 404) {
      logger.warn('Message not found in Mitto', { providerMessageId });
      throw new Error(`Message not found in Mitto: ${providerMessageId}`);
    }
    logger.error('Failed to refresh message status', {
      providerMessageId,
      err: err.message,
    });
    throw err;
  }
}

/**
 * Refresh status for multiple messages (bulk)
 *
 * @param {Array<string>} providerMessageIds - Array of Mitto message IDs
 * @param {string} shopId - Shop ID for scoping (optional)
 * @param {number} limit - Maximum messages to process (default: 100)
 * @returns {Promise<Object>} Bulk refresh result
 */
export async function refreshMessageStatusBulk(
  providerMessageIds,
  shopId = null,
  limit = 100,
) {
  if (!Array.isArray(providerMessageIds) || providerMessageIds.length === 0) {
    throw new Error('providerMessageIds array is required and must not be empty');
  }

  // Limit to prevent abuse
  const limitedIds = providerMessageIds.slice(0, limit);
  const results = [];

  logger.info('Starting bulk status refresh', {
    total: providerMessageIds.length,
    limited: limitedIds.length,
    shopId,
  });

  // Process in parallel (with concurrency limit to avoid overwhelming Mitto)
  const CONCURRENCY = 10;
  for (let i = 0; i < limitedIds.length; i += CONCURRENCY) {
    const batch = limitedIds.slice(i, i + CONCURRENCY);
    const batchPromises = batch.map(async (providerMessageId) => {
      try {
        const result = await refreshMessageStatus(providerMessageId, shopId);
        return {
          providerMessageId,
          success: true,
          ...result,
        };
      } catch (err) {
        logger.warn('Failed to refresh message status in bulk', {
          providerMessageId,
          err: err.message,
        });
        return {
          providerMessageId,
          success: false,
          code: 'REFRESH_FAILED',
          message: err.message,
        };
      }
    });

    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults);

    // Small delay between batches to avoid rate limiting
    if (i + CONCURRENCY < limitedIds.length) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  const successCount = results.filter((r) => r.success).length;
  const failedCount = results.length - successCount;

  logger.info('Bulk status refresh completed', {
    total: limitedIds.length,
    successful: successCount,
    failed: failedCount,
  });

  return {
    total: limitedIds.length,
    updated: successCount,
    failed: failedCount,
    results,
  };
}

export default {
  refreshMessageStatus,
  refreshMessageStatusBulk,
};

