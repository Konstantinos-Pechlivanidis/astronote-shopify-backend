import { cacheManager, CACHE_TTL } from '../utils/cache.js';
import { getStoreId } from './store-resolution.js';
import { logger } from '../utils/logger.js';

/**
 * Caching Middleware
 * Provides intelligent caching for API responses
 */

/**
 * Generate cache key for store-scoped endpoints
 * @param {Object} req - Express request
 * @param {string} prefix - Cache key prefix
 * @returns {string} Cache key
 */
function generateStoreKey(req, prefix) {
  try {
    const storeId = getStoreId(req);
    const queryString = JSON.stringify(req.query);
    return `${prefix}:${storeId}:${queryString}`;
  } catch {
    return null;
  }
}

/**
 * Cache middleware factory
 * @param {string} prefix - Cache key prefix
 * @param {number} ttl - Time to live in seconds
 * @returns {Function} Express middleware
 */
export function cacheMiddleware(prefix, ttl = CACHE_TTL.MEDIUM) {
  return async (req, res, next) => {
    // Only cache GET requests
    if (req.method !== 'GET') {
      return next();
    }

    const cacheKey = generateStoreKey(req, prefix);
    if (!cacheKey) {
      return next();
    }

    try {
      // Try to get from cache
      const cached = await cacheManager.get(cacheKey);
      if (cached) {
        logger.debug('Cache hit', { key: cacheKey });
        res.setHeader('X-Cache', 'HIT');
        res.setHeader('X-Cache-Key', cacheKey);
        return res.json(cached);
      }

      logger.debug('Cache miss', { key: cacheKey });

      // Store original json method
      const originalJson = res.json.bind(res);

      // Override json method to cache response
      res.json = function (data) {
        // Only cache successful responses
        if (res.statusCode >= 200 && res.statusCode < 300) {
          cacheManager.set(cacheKey, data, ttl).catch(err => {
            logger.error('Cache set error', {
              error: err.message,
              key: cacheKey,
            });
          });
        }

        res.setHeader('X-Cache', 'MISS');
        res.setHeader('X-Cache-Key', cacheKey);
        return originalJson(data);
      };

      next();
    } catch (error) {
      logger.error('Cache middleware error', { error: error.message });
      next();
    }
  };
}

/**
 * Invalidate cache for a specific store
 * @param {string} storeId - Store ID
 * @param {string} pattern - Cache pattern to clear
 */
export async function invalidateStoreCache(storeId, pattern) {
  try {
    const cachePattern = `${pattern}:${storeId}:*`;
    await cacheManager.clearPattern(cachePattern);
    logger.info('Cache invalidated', { storeId, pattern: cachePattern });
  } catch (error) {
    logger.error('Cache invalidation error', {
      error: error.message,
      storeId,
      pattern,
    });
  }
}

/**
 * Cache invalidation middleware for write operations
 * Invalidates cache after successful write operations
 * @param {string} patterns - Array of cache patterns to invalidate
 * @returns {Function} Express middleware
 */
export function invalidateCacheMiddleware(patterns = []) {
  return async (req, res, next) => {
    // Store original json method
    const originalJson = res.json.bind(res);

    // Override json method to invalidate cache after response
    res.json = function (data) {
      // Only invalidate on successful write operations
      if (
        res.statusCode >= 200 &&
        res.statusCode < 300 &&
        ['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)
      ) {
        try {
          const storeId = getStoreId(req);
          patterns.forEach(pattern => {
            invalidateStoreCache(storeId, pattern).catch(err => {
              logger.error('Cache invalidation error', {
                error: err.message,
                pattern,
              });
            });
          });
        } catch (error) {
          logger.error('Cache invalidation middleware error', {
            error: error.message,
          });
        }
      }

      return originalJson(data);
    };

    next();
  };
}

/**
 * Predefined cache middleware for common endpoints
 */

// Dashboard cache (5 minutes)
export const dashboardCache = cacheMiddleware('dashboard', CACHE_TTL.MEDIUM);

// Contacts list cache (2 minutes)
export const contactsListCache = cacheMiddleware(
  'contacts:list',
  CACHE_TTL.SHORT * 2,
);

// Contact stats cache (5 minutes)
export const contactsStatsCache = cacheMiddleware(
  'contacts:stats',
  CACHE_TTL.MEDIUM,
);

// Campaigns list cache (2 minutes)
export const campaignsListCache = cacheMiddleware(
  'campaigns:list',
  CACHE_TTL.SHORT * 2,
);

// Campaign metrics cache (1 minute)
export const campaignMetricsCache = cacheMiddleware(
  'campaigns:metrics',
  CACHE_TTL.SHORT,
);

// Billing balance cache (30 seconds)
export const billingBalanceCache = cacheMiddleware(
  'billing:balance',
  CACHE_TTL.SHORT / 2,
);

// Billing history cache (5 minutes)
export const billingHistoryCache = cacheMiddleware(
  'billing:history',
  CACHE_TTL.MEDIUM,
);

// Reports cache (15 minutes)
export const reportsCache = cacheMiddleware('reports', CACHE_TTL.LONG);

/**
 * Cache invalidation patterns for write operations
 */

// Invalidate contacts cache
export const invalidateContactsCache = invalidateCacheMiddleware([
  'contacts:list',
  'contacts:stats',
  'dashboard',
]);

// Invalidate campaigns cache
export const invalidateCampaignsCache = invalidateCacheMiddleware([
  'campaigns:list',
  'campaigns:metrics',
  'dashboard',
]);

// Invalidate billing cache
export const invalidateBillingCache = invalidateCacheMiddleware([
  'billing:balance',
  'billing:history',
  'dashboard',
]);

export default {
  cacheMiddleware,
  invalidateStoreCache,
  invalidateCacheMiddleware,
  dashboardCache,
  contactsListCache,
  contactsStatsCache,
  campaignsListCache,
  campaignMetricsCache,
  billingBalanceCache,
  billingHistoryCache,
  reportsCache,
  invalidateContactsCache,
  invalidateCampaignsCache,
  invalidateBillingCache,
};
