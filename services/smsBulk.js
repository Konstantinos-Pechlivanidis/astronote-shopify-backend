// services/smsBulk.js
// Bulk SMS sending service with credit enforcement

import { sendBulkMessages } from './mitto.js';
import { getBalance, debit } from './wallet.js';
import { generateUnsubscribeToken } from '../utils/unsubscribe.js';
import { isSubscriptionActive } from './subscription.js';
import { checkAllLimits } from './rateLimiter.js';
import { logger } from '../utils/logger.js';
import prisma from './prisma.js';

// Base URL for unsubscribe links (from env or default)
const baseFrontendUrl =
  process.env.UNSUBSCRIBE_BASE_URL ||
  process.env.FRONTEND_URL ||
  'https://astronote-shopify-frontend.onrender.com';
const UNSUBSCRIBE_BASE_URL = baseFrontendUrl;

/**
 * Send bulk SMS with credit enforcement
 * Checks balance before sending, debits ONLY after successful send (when messageId is received)
 *
 * @param {Array<Object>} messages - Array of message data objects
 * @param {string} messages[].shopId - Shop ID
 * @param {string} messages[].destination - Recipient phone number
 * @param {string} messages[].text - Message text
 * @param {string} [messages[].sender] - Optional sender override
 * @param {string} [messages[].trafficAccountId] - Optional traffic account ID override
 * @param {string} [messages[].contactId] - Optional contact ID for unsubscribe link
 * @param {Object} [messages[].meta] - Optional metadata (campaignId, messageId, etc.)
 * @param {string} messages[].internalRecipientId - Internal CampaignRecipient.id for mapping response
 * @returns {Promise<Object>} Result with bulkId, results array, and summary
 */
export async function sendBulkSMSWithCredits(messages) {
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    throw new Error('messages array is required and must not be empty');
  }

  // All messages should have the same shopId for credit checks
  const shopId = messages[0]?.shopId;
  if (!shopId) {
    throw new Error('shopId is required for all messages');
  }

  // Validate all messages have same shopId
  for (const msg of messages) {
    if (msg.shopId !== shopId) {
      throw new Error('All messages in a batch must have the same shopId');
    }
  }

  // 1. Check subscription status first
  const subscriptionActive = await isSubscriptionActive(shopId);
  if (!subscriptionActive) {
    logger.warn(
      { shopId, messageCount: messages.length },
      'Inactive subscription - bulk SMS send blocked',
    );
    return {
      bulkId: null,
      results: messages.map(msg => ({
        internalRecipientId: msg.internalRecipientId,
        sent: false,
        reason: 'inactive_subscription',
        error:
          'Active subscription required to send SMS. Please subscribe to a plan.',
      })),
      summary: {
        total: messages.length,
        sent: 0,
        failed: messages.length,
      },
    };
  }

  // 2. Check balance before sending (need credits for all messages)
  const balance = await getBalance(shopId);
  const requiredCredits = messages.length;

  if (balance < requiredCredits) {
    logger.warn(
      { shopId, balance, requiredCredits, messageCount: messages.length },
      'Insufficient credits for bulk SMS send',
    );
    return {
      bulkId: null,
      results: messages.map(msg => ({
        internalRecipientId: msg.internalRecipientId,
        sent: false,
        reason: 'insufficient_credits',
        balance,
        error: 'Not enough credits to send SMS. Please purchase credits.',
      })),
      summary: {
        total: messages.length,
        sent: 0,
        failed: messages.length,
      },
    };
  }

  // 3. Prepare messages for Mitto API
  const TRAFFIC_ACCOUNT_ID =
    process.env.SMS_TRAFFIC_ACCOUNT_ID ||
    process.env.MITTO_TRAFFIC_ACCOUNT_ID;

  const mittoMessages = [];
  const messageMapping = []; // Maps index in mittoMessages to internal recipient data

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    // Resolve sender
    let finalSender = msg.sender;
    if (!finalSender) {
      try {
        const settings = await prisma.shopSettings.findUnique({
          where: { shopId },
          select: { senderName: true, senderNumber: true },
        });
        finalSender =
          settings?.senderName ||
          settings?.senderNumber ||
          process.env.MITTO_SENDER_NAME ||
          'Astronote';
      } catch (senderErr) {
        logger.warn(
          { shopId, messageIndex: i, err: senderErr.message },
          'Failed to resolve sender, using default',
        );
        finalSender = process.env.MITTO_SENDER_NAME || 'Astronote';
      }
    }

    // Append unsubscribe link if contactId is provided
    let finalText = msg.text;
    if (msg.contactId) {
      try {
        const unsubscribeToken = generateUnsubscribeToken(
          msg.contactId,
          shopId,
          msg.destination,
        );
        const unsubscribeUrl = `${UNSUBSCRIBE_BASE_URL}/unsubscribe/${unsubscribeToken}`;
        finalText += `\n\nTo unsubscribe, tap: ${unsubscribeUrl}`;
      } catch (tokenErr) {
        logger.warn(
          { shopId, contactId: msg.contactId, err: tokenErr.message },
          'Failed to generate unsubscribe token, sending without link',
        );
        // Continue without unsubscribe link if token generation fails
      }
    }

    const trafficAccountId = msg.trafficAccountId || TRAFFIC_ACCOUNT_ID;
    if (!trafficAccountId) {
      logger.warn({ shopId, messageIndex: i }, 'No traffic account ID, skipping message');
      continue; // Skip this message
    }

    mittoMessages.push({
      trafficAccountId,
      destination: msg.destination,
      sms: {
        text: finalText,
        sender: finalSender,
      },
    });

    messageMapping.push({
      index: mittoMessages.length - 1,
      internalRecipientId: msg.internalRecipientId,
      shopId: msg.shopId,
      destination: msg.destination,
      text: finalText,
      meta: msg.meta || {},
    });
  }

  if (mittoMessages.length === 0) {
    logger.error({ shopId }, 'No valid messages to send after preparation');
    return {
      bulkId: null,
      results: messages.map(msg => ({
        internalRecipientId: msg.internalRecipientId,
        sent: false,
        reason: 'preparation_failed',
        error: 'Message preparation failed',
      })),
      summary: {
        total: messages.length,
        sent: 0,
        failed: messages.length,
      },
    };
  }

  // 4. Check rate limits before sending
  const trafficAccountId =
    mittoMessages[0]?.trafficAccountId || TRAFFIC_ACCOUNT_ID;

  const rateLimitCheck = await checkAllLimits(trafficAccountId, shopId);
  if (!rateLimitCheck.allowed) {
    logger.warn(
      {
        shopId,
        trafficAccountId,
        trafficAccountRemaining: rateLimitCheck.trafficAccountLimit.remaining,
        tenantRemaining: rateLimitCheck.tenantLimit.remaining,
      },
      'Rate limit exceeded, throwing error for retry (Phase 2.1)',
    );

    // Phase 2.1: Throw error to trigger BullMQ retry
    const error = new Error(
      'Rate limit exceeded. Please try again in a moment.',
    );
    error.reason = 'rate_limit_exceeded';
    error.status = 429; // Standard HTTP status for Too Many Requests
    throw error;
  }

  // 5. Call Mitto bulk API
  logger.info(
    { shopId, messageCount: mittoMessages.length },
    'Calling Mitto bulk API',
  );

  let mittoResult;
  try {
    mittoResult = await sendBulkMessages(mittoMessages);
  } catch (mittoError) {
    logger.error(
      { shopId, messageCount: mittoMessages.length, error: mittoError.message },
      'Mitto bulk API call failed',
    );
    throw mittoError;
  }

  // 6. Map response to internal recipient IDs
  // Note: Mitto API preserves order, so index-based mapping is safe
  // However, we validate that response length matches request length
  if (mittoResult.messages.length !== messageMapping.length) {
    logger.error('Mitto response length mismatch', {
      shopId,
      requested: messageMapping.length,
      received: mittoResult.messages.length,
    });
    // This should not happen, but handle gracefully
    // Map what we can and mark the rest as failed
  }

  const results = messageMapping.map((mapping, idx) => {
    const mittoResponse = mittoResult.messages[idx];
    if (!mittoResponse) {
      logger.warn('Missing Mitto response for message', {
        shopId,
        index: idx,
        internalRecipientId: mapping.internalRecipientId,
      });
      return {
        internalRecipientId: mapping.internalRecipientId,
        sent: false,
        messageId: null,
        bulkId: mittoResult.bulkId,
        error: 'Missing response from Mitto API',
      };
    }
    return {
      internalRecipientId: mapping.internalRecipientId,
      sent: !!mittoResponse?.messageId,
      messageId: mittoResponse?.messageId || null,
      bulkId: mittoResult.bulkId,
      error: mittoResponse?.error || null,
    };
  });

  // 7. Debit credits only for successful sends
  const successfulCount = results.filter(r => r.sent).length;
  if (successfulCount > 0) {
    try {
      await debit(shopId, successfulCount, {
        reason: `sms:send:campaign:${messages[0]?.meta?.campaignId || 'unknown'}`,
        campaignId: messages[0]?.meta?.campaignId || null,
      });
      logger.info(
        { shopId, successfulCount, campaignId: messages[0]?.meta?.campaignId },
        'Credits debited for successful bulk SMS sends',
      );
    } catch (debitError) {
      logger.error(
        { shopId, successfulCount, error: debitError.message },
        'Failed to debit credits after successful send',
      );
      // Don't throw - credits will be tracked manually if needed
    }
  }

  logger.info(
    {
      shopId,
      bulkId: mittoResult.bulkId,
      total: messages.length,
      sent: successfulCount,
      failed: messages.length - successfulCount,
    },
    'Bulk SMS send completed',
  );

  return {
    bulkId: mittoResult.bulkId,
    results,
    summary: {
      total: messages.length,
      sent: successfulCount,
      failed: messages.length - successfulCount,
    },
  };
}

export default { sendBulkSMSWithCredits };

