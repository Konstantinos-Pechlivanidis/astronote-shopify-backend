import crypto from 'crypto';
import { logger } from '../utils/logger.js';
import { AuthenticationError } from '../utils/errors.js';

/**
 * Verify Shopify webhook HMAC signature
 * Shopify sends webhooks with X-Shopify-Hmac-Sha256 header
 * @param {Object} req - Express request object
 * @returns {boolean} True if signature is valid
 */
function verifyShopifyWebhookSignature(req) {
  const hmacHeader = req.get('X-Shopify-Hmac-Sha256');
  const shopDomain = req.get('X-Shopify-Shop-Domain');
  const topic = req.get('X-Shopify-Topic');

  if (!hmacHeader) {
    logger.warn('Missing Shopify HMAC signature header', {
      shopDomain,
      topic,
      path: req.path,
    });
    return false;
  }

  // Get the webhook secret from environment
  const webhookSecret =
    process.env.SHOPIFY_WEBHOOK_SECRET || process.env.SHOPIFY_API_SECRET;

  if (!webhookSecret) {
    logger.error('Shopify webhook secret not configured', {
      shopDomain,
      topic,
    });
    // In development, allow webhooks if secret is not set (for testing)
    if (process.env.NODE_ENV === 'development') {
      logger.warn(
        'Allowing webhook in development mode (no secret configured)',
      );
      return true;
    }
    return false;
  }

  // Get raw body for signature verification
  // The raw body should be stored by body-parser middleware as Buffer
  let rawBody = req.rawBody;
  if (rawBody && Buffer.isBuffer(rawBody)) {
    // Convert Buffer to string for HMAC calculation
    rawBody = rawBody.toString('utf8');
  } else if (!rawBody && req.body) {
    // Fallback: reconstruct from parsed body (less secure but better than nothing)
    rawBody = JSON.stringify(req.body);
  }
  if (!rawBody) {
    logger.warn('No raw body available for webhook verification', {
      shopDomain,
      topic,
    });
    return false;
  }

  // Calculate HMAC
  // Shopify uses the raw body (as received) for HMAC calculation
  const calculatedHmac = crypto
    .createHmac('sha256', webhookSecret)
    .update(rawBody)
    .digest('base64');

  // Compare HMACs (use timing-safe comparison to prevent timing attacks)
  const isValid = crypto.timingSafeEqual(
    Buffer.from(calculatedHmac),
    Buffer.from(hmacHeader),
  );

  if (!isValid) {
    logger.warn('Shopify webhook signature verification failed', {
      shopDomain,
      topic,
      path: req.path,
      expectedHmac: `${calculatedHmac.substring(0, 10)}...`,
      receivedHmac: `${hmacHeader.substring(0, 10)}...`,
    });
  } else {
    logger.debug('Shopify webhook signature verified', {
      shopDomain,
      topic,
      path: req.path,
    });
  }

  return isValid;
}

/**
 * Middleware to verify Shopify webhook signatures
 * Should be used before webhook handlers
 */
export function validateShopifyWebhook(req, res, next) {
  try {
    const isValid = verifyShopifyWebhookSignature(req);

    if (!isValid) {
      logger.error('Shopify webhook signature validation failed', {
        shopDomain: req.get('X-Shopify-Shop-Domain'),
        topic: req.get('X-Shopify-Topic'),
        path: req.path,
        method: req.method,
      });

      throw new AuthenticationError('Invalid Shopify webhook signature');
    }

    // Attach webhook metadata to request for use in handlers
    req.webhookMetadata = {
      shopDomain: req.get('X-Shopify-Shop-Domain'),
      topic: req.get('X-Shopify-Topic'),
      hmac: req.get('X-Shopify-Hmac-Sha256'),
    };

    next();
  } catch (error) {
    if (error instanceof AuthenticationError) {
      return res.status(401).json({
        success: false,
        error: 'Invalid webhook signature',
        message: 'The webhook signature could not be verified',
        code: 'INVALID_WEBHOOK_SIGNATURE',
      });
    }

    logger.error('Error validating Shopify webhook', {
      error: error.message,
      stack: error.stack,
      path: req.path,
    });

    return res.status(500).json({
      success: false,
      error: 'Webhook validation error',
      message: 'An error occurred while validating the webhook',
      code: 'WEBHOOK_VALIDATION_ERROR',
    });
  }
}

export default {
  validateShopifyWebhook,
  verifyShopifyWebhookSignature,
};
