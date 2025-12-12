import axios from 'axios';
import { logger } from '../utils/logger.js';
import {
  validateAndConsumeCredits,
  InsufficientCreditsError,
} from './credit-validation.js';

// Custom error classes for better error handling
export class MittoApiError extends Error {
  constructor(message, status, response) {
    super(message);
    this.name = 'MittoApiError';
    this.status = status;
    this.response = response;
  }
}

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

// E.164 phone number validation
function validateE164PhoneNumber(phone) {
  // E.164 format: +[country code][number] (max 15 digits including country code)
  const e164Regex = /^\+[1-9]\d{1,14}$/;
  return e164Regex.test(phone);
}

// Get sender from client settings or fallback to env
async function getSender(shopId, senderOverride = null) {
  if (senderOverride) {
    return senderOverride;
  }

  if (shopId) {
    try {
      const prisma = (await import('./prisma.js')).default;
      const settings = await prisma.shopSettings.findUnique({
        where: { shopId },
        select: { senderName: true, senderNumber: true },
      });

      if (settings?.senderName) {
        return settings.senderName;
      }
    } catch (error) {
      logger.warn('Failed to fetch shop settings for sender', {
        shopId,
        error: error.message,
      });
    }
  }

  // Fallback to environment default
  return process.env.MITTO_SENDER_NAME || 'Astronote';
}

const mitto = axios.create({
  baseURL: process.env.MITTO_API_BASE || 'https://messaging.mittoapi.com',
  timeout: 30000,
});

mitto.interceptors.request.use(config => {
  config.headers = {
    ...(config.headers || {}),
    'X-Mitto-API-Key': process.env.MITTO_API_KEY,
    'Content-Type': 'application/json',
  };
  return config;
});

mitto.interceptors.response.use(
  response => response,
  error => {
    const status = error.response?.status;
    const response = error.response?.data;

    logger.error('Mitto API Error', {
      status,
      response,
      message: error.message,
    });

    throw new MittoApiError(
      `Mitto API error: ${response?.message || error.message}`,
      status,
      response,
    );
  },
);

/**
 * Send SMS via Mitto API v1.1
 * @param {Object} params
 * @param {string} params.to - E.164 phone number (e.g., +357123456789)
 * @param {string} params.text - SMS message text
 * @param {string} [params.senderOverride] - Override sender name
 * @param {string} [params.shopId] - Shop ID for client settings lookup
 * @param {boolean} [params.skipCreditCheck] - Skip credit consumption (for campaign messages where credits already consumed)
 * @returns {Promise<{messageId: string, status: string}>}
 */
export async function sendSms({
  to,
  text,
  senderOverride = null,
  shopId = null,
  skipCreditCheck = false,
}) {
  try {
    // Validate phone number
    if (!validateE164PhoneNumber(to)) {
      throw new ValidationError(
        `Invalid phone number format. Expected E.164 format (e.g., +357123456789), got: ${to}`,
      );
    }

    // Validate and consume credits if shopId is provided AND not skipping (campaign messages already consumed credits)
    if (shopId && !skipCreditCheck) {
      try {
        const creditResult = await validateAndConsumeCredits(shopId, 1);
        logger.info('Credits validated and consumed for SMS', {
          shopId,
          creditsConsumed: creditResult.creditsConsumed,
          creditsRemaining: creditResult.creditsRemaining,
        });
      } catch (error) {
        if (error instanceof InsufficientCreditsError) {
          throw new ValidationError(error.message);
        }
        throw error;
      }
    } else if (shopId && skipCreditCheck) {
      // Campaign message - credits already consumed at campaign level
      logger.info('Skipping credit consumption (campaign message)', {
        shopId,
        destination: to,
      });
    }

    // Get sender name
    const sender = await getSender(shopId, senderOverride);

    // Prepare request payload
    const payload = {
      trafficAccountId: process.env.MITTO_TRAFFIC_ACCOUNT_ID,
      destination: to,
      sms: {
        text,
        sender,
      },
    };

    logger.info('Sending SMS via Mitto', {
      destination: to,
      sender,
      textLength: text.length,
    });

    // Make API call
    const { data } = await mitto.post('/api/v1.1/Messages/send', payload);

    // Handle Mitto response format
    const messageId = data.messages?.[0]?.messageId || data.id;
    const status = data.messages?.[0]?.status || data.status || 'sent';

    logger.info('SMS sent successfully', {
      messageId,
      status,
      destination: to,
    });

    return {
      messageId,
      status,
    };
  } catch (error) {
    if (error instanceof ValidationError || error instanceof MittoApiError) {
      throw error;
    }

    logger.error('Unexpected error in sendSms', {
      error: error.message,
      destination: to,
    });

    throw new Error(`Failed to send SMS: ${error.message}`);
  }
}

/**
 * Send bulk SMS messages via Mitto using the new bulk endpoint
 * @param {Array<Object>} messages - Array of message objects
 * @param {string} messages[].trafficAccountId - Traffic account ID
 * @param {string} messages[].destination - Recipient phone number (E.164)
 * @param {Object} messages[].sms - SMS object
 * @param {string} messages[].sms.text - Message text
 * @param {string} messages[].sms.sender - Sender name
 * @returns {Promise<{bulkId: string, messages: Array}>} Response with bulkId and messages array
 */
export async function sendBulkMessages(messages) {
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    throw new ValidationError('messages array is required and must not be empty');
  }

  // Validate all messages have required fields
  for (const msg of messages) {
    if (!msg.trafficAccountId || !msg.destination || !msg.sms || !msg.sms.text) {
      throw new ValidationError('Each message must have trafficAccountId, destination, and sms.text');
    }
    if (!validateE164PhoneNumber(msg.destination)) {
      throw new ValidationError(
        `Invalid phone number format: ${msg.destination}. Expected E.164 format.`,
      );
    }
  }

  logger.info('Sending bulk SMS via Mitto', {
    messageCount: messages.length,
    trafficAccountId: messages[0]?.trafficAccountId,
  });

  try {
    const { data } = await mitto.post('/api/v1.1/Messages/sendmessagesbulk', {
      messages,
    });

    // Validate response format
    if (!data.bulkId) {
      logger.error('Invalid Mitto bulk response format: missing bulkId', { response: data });
      throw new MittoApiError(
        'Invalid response from Mitto API: missing bulkId',
        500,
        data,
      );
    }

    if (!data.messages || !Array.isArray(data.messages)) {
      logger.error('Invalid Mitto bulk response format: missing messages array', {
        response: data,
      });
      throw new MittoApiError(
        'Invalid response from Mitto API: missing messages array',
        500,
        data,
      );
    }

    logger.info('Bulk SMS sent successfully via Mitto', {
      bulkId: data.bulkId,
      messageCount: data.messages.length,
    });

    return {
      bulkId: data.bulkId,
      messages: data.messages,
      rawResponse: data,
    };
  } catch (error) {
    if (error instanceof ValidationError || error instanceof MittoApiError) {
      throw error;
    }

    logger.error('Unexpected error in sendBulkMessages', {
      error: error.message,
      messageCount: messages.length,
    });

    throw new MittoApiError(
      `Failed to send bulk SMS: ${error.message}`,
      error.response?.status,
      error.response?.data,
    );
  }
}

/**
 * Get message delivery status from Mitto API
 * @param {string} messageId - Mitto message ID
 * @returns {Promise<{messageId: string, deliveryStatus: string, createdAt: string, updatedAt: string}>}
 */
export async function getMessageStatus(messageId) {
  try {
    logger.info('Fetching message status from Mitto', { messageId });

    const { data } = await mitto.get(`/api/v1.1/Messages/${messageId}`);

    logger.info('Message status retrieved', {
      messageId: data.messageId,
      deliveryStatus: data.deliveryStatus,
    });

    return {
      messageId: data.messageId,
      deliveryStatus: data.deliveryStatus,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
    };
  } catch (error) {
    logger.error('Failed to fetch message status', {
      messageId,
      error: error.message,
    });

    throw new MittoApiError(
      `Failed to fetch message status: ${error.message}`,
      error.response?.status,
      error.response?.data,
    );
  }
}

export default { sendSms, sendBulkMessages, getMessageStatus };
