import prisma from '../services/prisma.js';
import { getMessageStatus } from '../services/mitto.js';
import { logger } from '../utils/logger.js';
import { getStoreId } from '../middlewares/store-resolution.js';
import { ValidationError, NotFoundError } from '../utils/errors.js';
import { sendSuccess } from '../utils/response.js';

/**
 * Get delivery status for a specific message
 * GET /api/tracking/mitto/:messageId
 */
export async function getMittoMessageStatus(req, res, next) {
  try {
    const { messageId } = req.params;
    const storeId = getStoreId(req); // ✅ Security: Get store ID from context

    if (!messageId) {
      throw new ValidationError('Message ID is required');
    }

    // ✅ Security: Get current status from database with shopId validation
    const messageLog = await prisma.messageLog.findFirst({
      where: {
        providerMsgId: messageId,
        shopId: storeId, // ✅ Validate message belongs to store
      },
      select: {
        id: true,
        phoneE164: true,
        status: true,
        deliveryStatus: true,
        senderNumber: true,
        createdAt: true,
        updatedAt: true,
        campaignId: true,
        campaign: {
          select: {
            name: true,
            status: true,
          },
        },
      },
    });

    if (!messageLog) {
      throw new NotFoundError('Message');
    }

    // Fetch latest status from Mitto API
    try {
      const mittoStatus = await getMessageStatus(messageId);

      // Update database with latest status if it changed
      if (mittoStatus.deliveryStatus !== messageLog.deliveryStatus) {
        await prisma.messageLog.update({
          where: { id: messageLog.id },
          data: {
            deliveryStatus: mittoStatus.deliveryStatus,
            updatedAt: new Date(),
          },
        });

        // Update campaign recipient if exists
        if (messageLog.campaignId) {
          await prisma.campaignRecipient.updateMany({
            where: {
              campaignId: messageLog.campaignId,
              mittoMessageId: messageId,
            },
            data: {
              deliveryStatus: mittoStatus.deliveryStatus,
              deliveredAt:
                mittoStatus.deliveryStatus === 'Delivered' ? new Date() : null,
            },
          });

          // Update campaign metrics
          if (mittoStatus.deliveryStatus === 'Delivered') {
            await prisma.campaignMetrics.update({
              where: { campaignId: messageLog.campaignId },
              data: { totalDelivered: { increment: 1 } },
            });
          } else if (mittoStatus.deliveryStatus === 'Failed') {
            await prisma.campaignMetrics.update({
              where: { campaignId: messageLog.campaignId },
              data: { totalFailed: { increment: 1 } },
            });
          }
        }
      }

      return sendSuccess(res, {
        messageId,
        phoneE164: messageLog.phoneE164,
        status: messageLog.status,
        deliveryStatus: mittoStatus.deliveryStatus,
        senderNumber: messageLog.senderNumber,
        createdAt: messageLog.createdAt,
        updatedAt: mittoStatus.updatedAt,
        campaign: messageLog.campaign,
      });
    } catch (error) {
      logger.error('Failed to fetch status from Mitto', {
        messageId,
        error: error.message,
      });

      // Return database status if Mitto API fails
      return sendSuccess(res, {
        messageId,
        phoneE164: messageLog.phoneE164,
        status: messageLog.status,
        deliveryStatus: messageLog.deliveryStatus,
        senderNumber: messageLog.senderNumber,
        createdAt: messageLog.createdAt,
        updatedAt: messageLog.updatedAt,
        campaign: messageLog.campaign,
        warning: 'Status may not be up-to-date due to API error',
      });
    }
  } catch (error) {
    logger.error('Error in getMittoMessageStatus', {
      messageId: req.params.messageId,
      error: error.message,
    });
    next(error);
  }
}

/**
 * Get delivery status for all messages in a campaign
 * GET /api/tracking/campaign/:campaignId
 */
export async function getCampaignDeliveryStatus(req, res, next) {
  try {
    const { campaignId } = req.params;
    const storeId = getStoreId(req); // ✅ Security: Use storeId instead of shopDomain

    // ✅ Security: Verify campaign belongs to shop using storeId
    const campaign = await prisma.campaign.findFirst({
      where: {
        id: campaignId,
        shopId: storeId, // ✅ More secure: direct shopId check
      },
      include: {
        metrics: true,
        recipients: {
          select: {
            id: true,
            phoneE164: true,
            status: true,
            deliveryStatus: true,
            senderNumber: true,
            sentAt: true,
            deliveredAt: true,
            error: true,
          },
        },
      },
    });

    if (!campaign) {
      throw new NotFoundError('Campaign');
    }

    // Get delivery statistics
    const stats = {
      total: campaign.recipients.length,
      sent: campaign.recipients.filter(r => r.status === 'sent').length,
      delivered: campaign.recipients.filter(
        r => r.deliveryStatus === 'Delivered',
      ).length,
      failed: campaign.recipients.filter(r => r.deliveryStatus === 'Failed')
        .length,
      queued: campaign.recipients.filter(r => r.deliveryStatus === 'Queued')
        .length,
      pending: campaign.recipients.filter(
        r => !r.deliveryStatus || r.deliveryStatus === 'Queued',
      ).length,
    };

    return sendSuccess(res, {
      campaignId: campaign.id, // ✅ Add campaignId for test compatibility
      campaign: {
        id: campaign.id,
        name: campaign.name,
        status: campaign.status,
        createdAt: campaign.createdAt,
      },
      messages: campaign.recipients, // ✅ Rename recipients to messages for test compatibility
      summary: stats, // ✅ Rename statistics to summary for test compatibility
      metrics: campaign.metrics,
    });
  } catch (error) {
    logger.error('Error in getCampaignDeliveryStatus', {
      campaignId: req.params.campaignId,
      error: error.message,
    });
    next(error);
  }
}

/**
 * Bulk update delivery status for multiple messages
 * POST /api/tracking/bulk-update
 */
export async function bulkUpdateDeliveryStatus(req, res, next) {
  try {
    const { messageIds } = req.body;

    if (!Array.isArray(messageIds) || messageIds.length === 0) {
      throw new ValidationError('Message IDs array is required');
    }

    const results = [];

    const storeId = getStoreId(req); // ✅ Security: Get store ID

    for (const messageId of messageIds) {
      try {
        const mittoStatus = await getMessageStatus(messageId);

        // ✅ Security: Update message log with shopId validation
        await prisma.messageLog.updateMany({
          where: {
            providerMsgId: messageId,
            shopId: storeId, // ✅ Only update messages from this store
          },
          data: {
            deliveryStatus: mittoStatus.deliveryStatus,
            updatedAt: new Date(),
          },
        });

        // ✅ Security: Update campaign recipient with store validation
        const recipient = await prisma.campaignRecipient.findFirst({
          where: {
            mittoMessageId: messageId,
            campaign: {
              shopId: storeId, // ✅ Validate campaign belongs to store
            },
          },
        });

        if (recipient) {
          await prisma.campaignRecipient.update({
            where: { id: recipient.id },
            data: {
              deliveryStatus: mittoStatus.deliveryStatus,
              deliveredAt:
                mittoStatus.deliveryStatus === 'Delivered' ? new Date() : null,
            },
          });
        }

        results.push({
          messageId,
          deliveryStatus: mittoStatus.deliveryStatus,
          success: true,
        });
      } catch (error) {
        logger.error('Failed to update message status', {
          messageId,
          error: error.message,
        });

        results.push({
          messageId,
          error: error.message,
          success: false,
        });
      }
    }

    return sendSuccess(res, {
      updated: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      results,
    });
  } catch (error) {
    logger.error('Error in bulkUpdateDeliveryStatus', {
      error: error.message,
    });
    next(error);
  }
}
