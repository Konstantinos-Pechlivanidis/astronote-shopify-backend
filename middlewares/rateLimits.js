import rateLimit from 'express-rate-limit';
import { getStoreId } from './store-resolution.js';

/**
 * Rate Limiting Configuration
 * All limits are per-store to prevent cross-store rate limit interference
 */

// Key generator for per-store rate limiting
const storeKeyGenerator = req => {
  try {
    const storeId = getStoreId(req);
    return `store:${storeId}`;
  } catch {
    return req.ip; // Fallback to IP if store ID not available
  }
};

// Standard error handler
const standardHandler = (req, res) => {
  res.status(429).json({
    success: false,
    error: 'rate_limit_exceeded',
    message: 'Too many requests. Please try again later.',
    retryAfter: res.getHeader('Retry-After'),
  });
};

/**
 * General API rate limit (for most endpoints)
 * 100 requests per minute per store
 */
export const generalRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100,
  keyGenerator: storeKeyGenerator,
  handler: standardHandler,
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Strict rate limit (for write operations)
 * 30 requests per minute per store
 */
export const strictRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: storeKeyGenerator,
  handler: standardHandler,
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Contacts rate limit
 * 60 requests per minute per store
 */
export const contactsRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  keyGenerator: storeKeyGenerator,
  handler: standardHandler,
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Campaigns rate limit
 * 40 requests per minute per store
 */
export const campaignsRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 40,
  keyGenerator: storeKeyGenerator,
  handler: standardHandler,
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Campaign send rate limit (very strict)
 * 5 requests per minute per store
 */
export const campaignSendRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  keyGenerator: storeKeyGenerator,
  handler: standardHandler,
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Billing rate limit
 * 20 requests per minute per store
 */
export const billingRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  keyGenerator: storeKeyGenerator,
  handler: standardHandler,
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Import rate limit (very strict)
 * 3 requests per 5 minutes per store
 */
export const importRateLimit = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 3,
  keyGenerator: storeKeyGenerator,
  handler: standardHandler,
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Reports rate limits
 */
export const rlReportsOverview = rateLimit({
  windowMs: 60 * 1000,
  max: 50,
  keyGenerator: storeKeyGenerator,
  handler: standardHandler,
  standardHeaders: true,
  legacyHeaders: false,
});

export const rlReportsGeneral = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: storeKeyGenerator,
  handler: standardHandler,
  standardHeaders: true,
  legacyHeaders: false,
});

export const rlReportsExport = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  keyGenerator: storeKeyGenerator,
  handler: standardHandler,
  standardHeaders: true,
  legacyHeaders: false,
});

export default {
  generalRateLimit,
  strictRateLimit,
  contactsRateLimit,
  campaignsRateLimit,
  campaignSendRateLimit,
  billingRateLimit,
  importRateLimit,
  rlReportsOverview,
  rlReportsGeneral,
  rlReportsExport,
};
