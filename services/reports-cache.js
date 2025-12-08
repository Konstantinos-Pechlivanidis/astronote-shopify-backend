import { cacheRedis } from '../config/redis.js';
import { logger } from '../utils/logger.js';

/**
 * Reports Cache Service
 *
 * Provides caching for frequently accessed reports to improve performance
 * Cache keys are store-specific and include date ranges for invalidation
 */

const CACHE_TTL = {
  KPIS: 300, // 5 minutes
  OVERVIEW: 600, // 10 minutes
  CAMPAIGNS: 300, // 5 minutes
  AUTOMATIONS: 600, // 10 minutes
  CREDITS: 300, // 5 minutes
  CONTACTS: 900, // 15 minutes
  MESSAGING: 300, // 5 minutes
};

/**
 * Generate cache key for reports
 * @param {string} storeId - Store ID
 * @param {string} reportType - Type of report
 * @param {Object} filters - Report filters
 * @returns {string} Cache key
 */
function generateCacheKey(storeId, reportType, filters = {}) {
  const { from, to, status, type, usageType } = filters;
  const filterString = JSON.stringify({ from, to, status, type, usageType });
  return `reports:${storeId}:${reportType}:${Buffer.from(filterString).toString('base64')}`;
}

/**
 * Get cached report data
 * @param {string} storeId - Store ID
 * @param {string} reportType - Type of report
 * @param {Object} filters - Report filters
 * @returns {Promise<Object|null>} Cached data or null
 */
export async function getCachedReport(storeId, reportType, filters = {}) {
  try {
    const cacheKey = generateCacheKey(storeId, reportType, filters);
    const cached = await cacheRedis.get(cacheKey);

    if (cached) {
      logger.info('Cache hit for report', { storeId, reportType, cacheKey });
      return JSON.parse(cached);
    }

    return null;
  } catch (error) {
    logger.error('Failed to get cached report', {
      storeId,
      reportType,
      error: error.message,
    });
    return null;
  }
}

/**
 * Cache report data
 * @param {string} storeId - Store ID
 * @param {string} reportType - Type of report
 * @param {Object} filters - Report filters
 * @param {Object} data - Report data to cache
 * @returns {Promise<void>}
 */
export async function cacheReport(storeId, reportType, filters = {}, data) {
  try {
    const cacheKey = generateCacheKey(storeId, reportType, filters);
    const ttl = CACHE_TTL[reportType.toUpperCase()] || 300;

    await cacheRedis.setex(cacheKey, ttl, JSON.stringify(data));
    logger.info('Report cached successfully', {
      storeId,
      reportType,
      cacheKey,
      ttl,
    });
  } catch (error) {
    logger.error('Failed to cache report', {
      storeId,
      reportType,
      error: error.message,
    });
  }
}

/**
 * Invalidate cache for a specific store
 * @param {string} storeId - Store ID
 * @param {string} [reportType] - Specific report type to invalidate
 * @returns {Promise<void>}
 */
export async function invalidateStoreCache(storeId, reportType = null) {
  try {
    const pattern = reportType
      ? `reports:${storeId}:${reportType}:*`
      : `reports:${storeId}:*`;

    const keys = await cacheRedis.keys(pattern);

    if (keys.length > 0) {
      await cacheRedis.del(...keys);
      logger.info('Cache invalidated', {
        storeId,
        reportType,
        keysCount: keys.length,
      });
    }
  } catch (error) {
    logger.error('Failed to invalidate cache', {
      storeId,
      reportType,
      error: error.message,
    });
  }
}

/**
 * Invalidate cache after data changes
 * @param {string} storeId - Store ID
 * @param {string} changeType - Type of change (campaign, automation, message, etc.)
 * @returns {Promise<void>}
 */
export async function invalidateOnChange(storeId, changeType) {
  try {
    // Invalidate relevant caches based on change type
    const invalidateTypes = [];

    switch (changeType) {
    case 'campaign':
      invalidateTypes.push('campaigns', 'overview', 'kpis', 'messaging');
      break;
    case 'automation':
      invalidateTypes.push('automations', 'overview', 'kpis');
      break;
    case 'message':
      invalidateTypes.push('messaging', 'campaigns', 'overview', 'kpis');
      break;
    case 'credit':
      invalidateTypes.push('credits', 'overview', 'kpis');
      break;
    case 'contact':
      invalidateTypes.push('contacts', 'overview', 'kpis');
      break;
    default:
      // Invalidate all caches for this store
      await invalidateStoreCache(storeId);
      return;
    }

    // Invalidate specific report types
    for (const reportType of invalidateTypes) {
      await invalidateStoreCache(storeId, reportType);
    }

    logger.info('Cache invalidated on change', {
      storeId,
      changeType,
      invalidateTypes,
    });
  } catch (error) {
    logger.error('Failed to invalidate cache on change', {
      storeId,
      changeType,
      error: error.message,
    });
  }
}

/**
 * Get cache statistics
 * @param {string} storeId - Store ID
 * @returns {Promise<Object>} Cache statistics
 */
export async function getCacheStats(storeId) {
  try {
    const pattern = `reports:${storeId}:*`;
    const keys = await cacheRedis.keys(pattern);

    const stats = {
      totalKeys: keys.length,
      keysByType: {},
      totalSize: 0,
    };

    for (const key of keys) {
      const parts = key.split(':');
      const reportType = parts[2];
      stats.keysByType[reportType] = (stats.keysByType[reportType] || 0) + 1;

      // Get key size (approximate)
      const ttl = await cacheRedis.ttl(key);
      if (ttl > 0) {
        stats.totalSize += 1; // Count as 1 unit for simplicity
      }
    }

    return stats;
  } catch (error) {
    logger.error('Failed to get cache stats', {
      storeId,
      error: error.message,
    });
    return { totalKeys: 0, keysByType: {}, totalSize: 0 };
  }
}

export default {
  getCachedReport,
  cacheReport,
  invalidateStoreCache,
  invalidateOnChange,
  getCacheStats,
};
