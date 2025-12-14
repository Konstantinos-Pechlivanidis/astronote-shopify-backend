import prisma from '../../services/prisma.js';
import { logger } from '../../utils/logger.js';
import { sendBulkSMSWithCredits } from '../../services/smsBulk.js';
import { deliveryStatusQueue } from '../index.js';
import { updateCampaignAggregates } from '../../services/campaignAggregates.js';
import { replacePlaceholders } from '../../utils/personalization.js';
import { appendUnsubscribeLink } from '../../utils/unsubscribe.js';
import { shortenUrlsInText } from '../../utils/urlShortener.js';
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
  // #region agent log
  fetch('http://127.0.0.1:7242/ingest/72a17531-4a03-4868-9574-6d14ee68fc32',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'bulkSms.js:32',message:'handleBulkSMS ENTRY',data:{jobId:job.id,campaignId,shopId,recipientIdsCount:recipientIds?.length,first5Recipients:recipientIds?.slice(0,5)},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
  // #endregion

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
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/72a17531-4a03-4868-9574-6d14ee68fc32',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'bulkSms.js:67',message:'Recipients found in DB',data:{campaignId,jobId:job.id,requestedCount:recipientIds.length,foundCount:recipients.length,alreadySent},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
    // #endregion
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
    const bulkMessages = await Promise.all(
      recipients.map(async (recipient) => {
        // Get message template from campaign
        let messageText = recipient.campaign.message;

        // Replace personalization placeholders
        messageText = replacePlaceholders(messageText, {
          firstName: recipient.contact?.firstName || '',
          lastName: recipient.contact?.lastName || '',
          discountCode,
        });

        // Shorten any URLs in the message text
        messageText = await shortenUrlsInText(messageText);

        // Append unsubscribe link (this also shortens the unsubscribe URL)
        const messageWithUnsubscribe = await appendUnsubscribeLink(
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
      }),
    );

    // CRITICAL: Re-check recipients status before sending (prevent duplicate sends from retries)
    // This check happens right before the API call to ensure we only send to truly pending recipients
    // Use a transaction to get a consistent snapshot of recipient statuses
    const currentRecipients = await prisma.$transaction(async tx => {
      return await tx.campaignRecipient.findMany({
        where: {
          id: { in: recipientIds },
          campaignId,
          status: 'pending',
          mittoMessageId: null, // CRITICAL: Only process unsent messages
        },
        select: { id: true, phoneE164: true },
      });
    });

    // Filter bulkMessages to only include recipients that are still pending
    const currentRecipientIds = new Set(currentRecipients.map(r => r.id));
    const filteredBulkMessages = bulkMessages.filter(msg =>
      currentRecipientIds.has(msg.internalRecipientId),
    );

    const skippedCount = bulkMessages.length - filteredBulkMessages.length;
    if (skippedCount > 0) {
      logger.warn(
        {
          campaignId,
          shopId,
          requestedCount: bulkMessages.length,
          currentPendingCount: currentRecipients.length,
          skippedCount,
          jobId: job.id,
          retryAttempt: job.attemptsMade || 0,
        },
        'Some recipients already sent (skipping to prevent duplicates)',
      );
    }

    if (filteredBulkMessages.length === 0) {
      logger.warn(
        {
          campaignId,
          shopId,
          requestedCount: bulkMessages.length,
          currentPendingCount: currentRecipients.length,
          jobId: job.id,
          retryAttempt: job.attemptsMade || 0,
        },
        'No pending recipients found (all already sent by another job or previous retry)',
      );
      return {
        ok: true,
        bulkId: null,
        successful: 0,
        failed: 0,
        skipped: bulkMessages.length,
        total: 0,
      };
    }

    // Send bulk SMS only for recipients that are still pending
    const result = await sendBulkSMSWithCredits(filteredBulkMessages);
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/72a17531-4a03-4868-9574-6d14ee68fc32',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'bulkSms.js:230',message:'sendBulkSMSWithCredits result',data:{campaignId,jobId:job.id,totalResults:result.results?.length,sentCount:result.results?.filter(r=>r.sent).length,failedCount:result.results?.filter(r=>!r.sent).length},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
    // #endregion

    // CRITICAL: Use transaction to ensure atomic updates and prevent race conditions
    // This prevents duplicate updates when jobs retry or run concurrently
    const updateResult = await prisma.$transaction(
      async tx => {
        const successfulIds = [];
        const failedIds = [];

        for (const res of result.results) {
          if (res.sent && res.messageId) {
            // CRITICAL: Atomic update with double idempotency check
            // #region agent log
            fetch('http://127.0.0.1:7242/ingest/72a17531-4a03-4868-9574-6d14ee68fc32',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'bulkSms.js:242',message:'BEFORE updateMany recipient',data:{campaignId,recipientId:res.internalRecipientId,messageId:res.messageId},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
            // #endregion
            const updateResult = await tx.campaignRecipient.updateMany({
              where: {
                id: res.internalRecipientId,
                mittoMessageId: null, // CRITICAL: Only update if not already sent
                status: 'pending', // Double check: only update pending recipients
              },
              data: {
                mittoMessageId: res.messageId,
                bulkId: result.bulkId,
                sentAt: new Date(),
                status: 'sent',
                deliveryStatus: 'Queued', // Initial status from Mitto
                error: null,
              },
            });
            // #region agent log
            fetch('http://127.0.0.1:7242/ingest/72a17531-4a03-4868-9574-6d14ee68fc32',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'bulkSms.js:257',message:'AFTER updateMany recipient',data:{campaignId,recipientId:res.internalRecipientId,updateCount:updateResult.count},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
            // #endregion

            if (updateResult.count > 0) {
              successfulIds.push(res.internalRecipientId);
            } else {
              logger.warn(
                {
                  campaignId,
                  shopId,
                  recipientId: res.internalRecipientId,
                  messageId: res.messageId,
                },
                'Recipient already sent (transaction idempotency check prevented duplicate)',
              );
            }
          } else {
            // Only update if still pending (idempotency)
            const updateResult = await tx.campaignRecipient.updateMany({
              where: {
                id: res.internalRecipientId,
                status: 'pending', // CRITICAL: Only update pending recipients
                mittoMessageId: null, // Double check: only update unsent
              },
              data: {
                status: 'failed',
                failedAt: new Date(),
                error: res.error || res.reason || 'Send failed',
                updatedAt: new Date(),
              },
            });

            if (updateResult.count > 0) {
              failedIds.push(res.internalRecipientId);
            } else {
              logger.warn(
                {
                  campaignId,
                  shopId,
                  recipientId: res.internalRecipientId,
                },
                'Recipient already processed (transaction idempotency check prevented duplicate)',
              );
            }
          }
        }

        return {
          successfulIds,
          failedIds,
        };
      },
      {
        timeout: 30000, // 30 second timeout for transaction (updates should be fast)
        maxWait: 5000, // 5 second max wait for lock
      },
    );
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/72a17531-4a03-4868-9574-6d14ee68fc32',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'bulkSms.js:312',message:'Transaction completed',data:{campaignId,jobId:job.id,successfulCount:updateResult.successfulIds.length,failedCount:updateResult.failedIds.length},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
    // #endregion

    const { successfulIds, failedIds } = updateResult;
    const skipped = bulkMessages.length - filteredBulkMessages.length;
    const bulkId = result.bulkId;
    const results = result.results;

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
    if (bulkId && successfulIds.length > 0) {
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
          bulkId,
        });
      } catch (queueError) {
        logger.warn('Failed to queue delivery status update', {
          campaignId,
          bulkId,
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
      bulkId,
      successful: successfulIds.length,
      failed: failedIds.length,
      skipped: skipped || 0,
      total: results.length,
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

