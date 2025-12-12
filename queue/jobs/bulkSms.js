import prisma from '../../services/prisma.js';
import { logger } from '../../utils/logger.js';
import { sendBulkSMSWithCredits } from '../../services/smsBulk.js';
import { deliveryStatusQueue } from '../index.js';
import { updateCampaignAggregates } from '../../services/campaignAggregates.js';
import { replacePlaceholders } from '../../utils/personalization.js';
import { appendUnsubscribeLink } from '../../utils/unsubscribe.js';
import { getDiscountCode } from '../../services/shopify.js';

/**
 * Check if error is retryable (Phase 2.1: Rate limiting retry)
 */
function isRetryable(err) {
  // Check for rate limit errors from our rate limiter (Phase 2.1)
  if (err?.reason === 'rate_limit_exceeded' ||
      err?.message?.includes('rate limit exceeded')) {
    return true; // Retryable - transient condition
  }

  const status = err?.status;
  if (!status) return true;      // network/timeout
  if (status >= 500) return true; // provider/server error
  if (status === 429) return true; // rate limited (HTTP 429)
  return false;                    // 4xx hard fail
}

/**
 * Process bulk SMS batch job
 * @param {Object} job - BullMQ job with campaignId, shopId, recipientIds
 */
export async function handleBulkSMS(job) {
  const { campaignId, shopId, recipientIds } = job.data;

  if (!campaignId || !shopId || !recipientIds || !Array.isArray(recipientIds) || recipientIds.length === 0) {
    logger.error({ jobId: job.id, data: job.data }, 'Invalid bulk SMS job data');
    throw new Error('Invalid bulk SMS job data: missing campaignId, shopId, or recipientIds');
  }

  try {
    // Fetch campaign recipients (idempotency: only process pending, unsent messages)
    const recipients = await prisma.campaignRecipient.findMany({
      where: {
        id: { in: recipientIds },
        campaignId,
        status: 'pending',
        mittoMessageId: null, // Only process unsent messages
      },
      include: {
        contact: {
          select: {
            id: true,
            phoneE164: true,
            firstName: true,
            lastName: true,
          },
        },
        campaign: {
          select: {
            id: true,
            message: true,
            discountId: true,
          },
        },
      },
    });

    // Idempotency: Skip messages that were already sent (in case of retry)
    const alreadySent = recipientIds.length - recipients.length;
    if (alreadySent > 0) {
      logger.warn({
        campaignId,
        shopId,
        alreadySent,
        totalRequested: recipientIds.length,
      }, 'Some recipients already sent, skipping (idempotency)');
    }

    if (recipients.length === 0) {
      logger.warn({ campaignId, shopId, recipientIds }, 'No pending recipients found for batch');
      return { ok: true, processed: 0, skipped: alreadySent };
    }

    const startTime = Date.now();
    logger.info({
      campaignId,
      shopId,
      batchSize: recipients.length,
      requestedCount: recipientIds.length,
      jobId: job.id,
      retryAttempt: job.attemptsMade || 0,
    }, 'Processing bulk SMS batch job');

    // Fetch discount code if campaign has a discountId (fetch once, use for all recipients)
    let discountCode = '';
    if (recipients[0]?.campaign?.discountId) {
      try {
        const shop = await prisma.shop.findUnique({
          where: { id: shopId },
          select: { shopDomain: true },
        });

        if (shop?.shopDomain) {
          const discount = await getDiscountCode(
            shop.shopDomain,
            recipients[0].campaign.discountId,
          );
          discountCode = discount?.code || '';
        }
      } catch (error) {
        logger.warn(
          { shopId, campaignId, error: error.message },
          'Failed to fetch discount code, continuing without it',
        );
      }
    }

    // Get frontend base URL for unsubscribe links
    const frontendBaseUrl =
      process.env.FRONTEND_URL ||
      process.env.FRONTEND_BASE_URL ||
      'https://astronote-shopify-frontend.onrender.com';

    // Prepare messages for bulk sending
    const bulkMessages = recipients.map(recipient => {
      // Get message template from campaign
      let messageText = recipient.campaign.message;

      // Replace personalization placeholders
      messageText = replacePlaceholders(messageText, {
        firstName: recipient.contact?.firstName || '',
        lastName: recipient.contact?.lastName || '',
        discountCode,
      });

      // Append unsubscribe link
      const messageWithUnsubscribe = appendUnsubscribeLink(
        messageText,
        recipient.contactId,
        shopId,
        recipient.phoneE164,
        frontendBaseUrl,
      );

      return {
        shopId, // Use shopId to match smsBulk.service.js
        destination: recipient.phoneE164,
        text: messageWithUnsubscribe,
        contactId: recipient.contactId,
        internalRecipientId: recipient.id, // Use internalRecipientId to match smsBulk.service.js
        meta: {
          reason: `sms:send:campaign:${campaignId}`,
          campaignId,
          recipientId: recipient.id,
        },
      };
    });

    // Send bulk SMS via smsBulk service
    const result = await sendBulkSMSWithCredits(bulkMessages);

    // Update recipients with results
    const updatePromises = [];
    const successfulIds = [];
    const failedIds = [];

    for (const res of result.results) {
      const recipient = recipients.find(r => r.id === res.internalRecipientId);
      if (!recipient) continue;

      const updateData = {
        updatedAt: new Date(),
      };

      if (res.sent && res.messageId) {
        updateData.mittoMessageId = res.messageId;
        updateData.bulkId = result.bulkId;
        updateData.sentAt = new Date();
        updateData.status = 'sent';
        updateData.deliveryStatus = 'Queued'; // Initial status from Mitto
        updateData.error = null;
        successfulIds.push(res.internalRecipientId);
      } else {
        updateData.status = 'failed';
        updateData.failedAt = new Date();
        updateData.error = res.error || res.reason || 'Send failed';
        failedIds.push(res.internalRecipientId);
      }

      updatePromises.push(
        prisma.campaignRecipient.update({
          where: { id: res.internalRecipientId },
          data: updateData,
        }),
      );
    }

    await Promise.all(updatePromises);

    const duration = Date.now() - startTime;
    logger.info({
      campaignId,
      shopId,
      bulkId: result.bulkId,
      successful: successfulIds.length,
      failed: failedIds.length,
      total: result.results.length,
      duration,
      jobId: job.id,
      retryAttempt: job.attemptsMade || 0,
    }, 'Bulk SMS batch job completed');

    // Update campaign aggregates (non-blocking)
    try {
      await updateCampaignAggregates(campaignId, shopId);
    } catch (aggErr) {
      logger.warn({ campaignId, err: aggErr.message }, 'Failed to update campaign aggregates');
    }

    // Queue delivery status update jobs for successful sends
    if (result.bulkId && successfulIds.length > 0) {
      try {
        // First check after 30 seconds
        await deliveryStatusQueue.add(
          'update-campaign-status',
          { campaignId },
          {
            delay: 30000, // 30 seconds
            jobId: `status-update-${campaignId}-30s-${Date.now()}`,
          },
        );

        // Second check after 2 minutes
        await deliveryStatusQueue.add(
          'update-campaign-status',
          { campaignId },
          {
            delay: 120000, // 2 minutes
            jobId: `status-update-${campaignId}-2m-${Date.now()}`,
          },
        );

        // Final check after 5 minutes
        await deliveryStatusQueue.add(
          'update-campaign-status',
          { campaignId },
          {
            delay: 300000, // 5 minutes
            jobId: `status-update-${campaignId}-5m-${Date.now()}`,
          },
        );

        logger.debug('Queued delivery status update jobs', {
          campaignId,
          bulkId: result.bulkId,
        });
      } catch (queueError) {
        logger.warn('Failed to queue delivery status update', {
          campaignId,
          bulkId: result.bulkId,
          error: queueError.message,
        });
      }
    }

    // If there were failures, log them but don't throw (partial success is acceptable)
    if (failedIds.length > 0) {
      logger.warn({
        campaignId,
        failedCount: failedIds.length,
        failedIds: failedIds.slice(0, 10), // Log first 10 failed IDs
      }, 'Some messages in batch failed');
    }

    return {
      ok: true,
      bulkId: result.bulkId,
      successful: successfulIds.length,
      failed: failedIds.length,
      total: result.results.length,
    };

  } catch (e) {
    const retryable = isRetryable(e);
    logger.error({
      campaignId,
      shopId,
      recipientIds,
      retryable,
      err: e.message,
      stack: e.stack,
    }, 'Bulk SMS batch job failed');

    // Mark all recipients in batch as failed or pending (for retry)
    // Increment retry count for idempotency tracking
    await prisma.campaignRecipient.updateMany({
      where: {
        id: { in: recipientIds },
        campaignId,
        status: 'pending',  // Only update pending messages (idempotency)
      },
      data: {
        failedAt: retryable ? null : new Date(),
        status: retryable ? 'pending' : 'failed',
        error: e.message,
        retryCount: { increment: 1 },  // Track retry attempts
      },
    });

    // Update campaign aggregates
    try {
      await updateCampaignAggregates(campaignId, shopId);
    } catch (aggErr) {
      logger.warn({ campaignId, err: aggErr.message }, 'Failed to update campaign aggregates');
    }

    if (retryable) throw e;

    return {
      ok: false,
      error: e.message,
      retryable: false,
    };
  }
}

export default { handleBulkSMS };

