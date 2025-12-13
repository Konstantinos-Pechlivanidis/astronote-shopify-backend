import crypto from 'crypto';
import { logger } from './logger.js';

/**
 * Generate an unsubscribe token for a contact
 * @param {string} contactId - Contact ID
 * @param {string} shopId - Shop ID
 * @param {string} phoneE164 - Phone number (E.164 format)
 * @returns {string} Unsubscribe token
 */
export function generateUnsubscribeToken(contactId, shopId, phoneE164) {
  // Create a payload with contact info
  const payload = {
    contactId,
    shopId,
    phoneE164,
    timestamp: Date.now(),
  };

  // Create a signed token using HMAC
  const secret =
    process.env.UNSUBSCRIBE_SECRET ||
    process.env.JWT_SECRET ||
    'default-secret-change-in-production';
  const payloadString = JSON.stringify(payload);
  const signature = crypto
    .createHmac('sha256', secret)
    .update(payloadString)
    .digest('hex');

  // Combine payload and signature
  const token = `${Buffer.from(payloadString).toString('base64url')}.${signature}`;

  return token;
}

/**
 * Verify and decode an unsubscribe token
 * @param {string} token - Unsubscribe token
 * @returns {Object|null} Decoded payload or null if invalid
 */
export function verifyUnsubscribeToken(token) {
  try {
    const [payloadBase64, signature] = token.split('.');

    if (!payloadBase64 || !signature) {
      logger.warn('Invalid unsubscribe token format', {
        token: `${token.substring(0, 20)}...`,
      });
      return null;
    }

    // Decode payload
    const payloadString = Buffer.from(payloadBase64, 'base64url').toString(
      'utf-8',
    );
    const payload = JSON.parse(payloadString);

    // Verify signature
    const secret =
      process.env.UNSUBSCRIBE_SECRET ||
      process.env.JWT_SECRET ||
      'default-secret-change-in-production';
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(payloadString)
      .digest('hex');

    if (signature !== expectedSignature) {
      logger.warn('Invalid unsubscribe token signature', {
        token: `${token.substring(0, 20)}...`,
      });
      return null;
    }

    // Check token expiration (30 days)
    const tokenAge = Date.now() - payload.timestamp;
    const maxAge = 30 * 24 * 60 * 60 * 1000; // 30 days in milliseconds

    if (tokenAge > maxAge) {
      logger.warn('Unsubscribe token expired', {
        tokenAge: `${Math.floor(tokenAge / (24 * 60 * 60 * 1000))} days`,
        contactId: payload.contactId,
      });
      return null;
    }

    return payload;
  } catch (error) {
    logger.error('Error verifying unsubscribe token', {
      error: error.message,
      token: `${token?.substring(0, 20)}...`,
    });
    return null;
  }
}

/**
 * Generate unsubscribe URL
 * @param {string} contactId - Contact ID
 * @param {string} shopId - Shop ID
 * @param {string} phoneE164 - Phone number (E.164 format)
 * @param {string} baseUrl - Base URL for the frontend
 * @returns {string} Unsubscribe URL
 */
export function generateUnsubscribeUrl(contactId, shopId, phoneE164, baseUrl) {
  const token = generateUnsubscribeToken(contactId, shopId, phoneE164);
  // Frontend route is /shopify/unsubscribe/:token
  return `${baseUrl}/shopify/unsubscribe/${token}`;
}

/**
 * Append unsubscribe link to SMS message
 * @param {string} message - Original message
 * @param {string} contactId - Contact ID
 * @param {string} shopId - Shop ID
 * @param {string} phoneE164 - Phone number (E.164 format)
 * @param {string} baseUrl - Base URL for the frontend
 * @returns {string} Message with unsubscribe link appended
 */
export async function appendUnsubscribeLink(
  message,
  contactId,
  shopId,
  phoneE164,
  baseUrl,
) {
  // Generate unsubscribe URL
  const unsubscribeUrl = generateUnsubscribeUrl(
    contactId,
    shopId,
    phoneE164,
    baseUrl,
  );

  // IMPORTANT: Do NOT shorten the unsubscribe URL
  // The custom URL shortener creates URLs like /s/{shortCode} but there's no route to handle them
  // This would cause 404 errors when users try to unsubscribe
  // The unsubscribe URL is already signed and secure, so we use it directly
  const unsubscribeText = `\n\nUnsubscribe: ${unsubscribeUrl}`;

  // Check if message + unsubscribe link exceeds SMS limits
  // Standard SMS: 160 characters, Concatenated SMS: 1600 characters
  const maxLength = 1600;
  const totalLength = message.length + unsubscribeText.length;

  if (totalLength > maxLength) {
    // Truncate message to fit unsubscribe link
    const truncatedMessage = `${message.substring(0, maxLength - unsubscribeText.length - 3)}...`;
    return truncatedMessage + unsubscribeText;
  }

  return message + unsubscribeText;
}
