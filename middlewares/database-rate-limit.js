import prisma from '../services/prisma.js';
import { logger } from '../utils/logger.js';
import { getStoreId } from './store-resolution.js';

/**
 * Database-Based Rate Limiting Middleware
 *
 * Fallback rate limiting using PostgreSQL when Redis is unavailable.
 * Provides per-store rate limiting with automatic cleanup.
 */

/**
 * Cleanup old rate limit records
 */
async function cleanupOldRecords() {
  try {
    const cutoffDate = new Date();
    cutoffDate.setMinutes(cutoffDate.getMinutes() - 5); // Keep records for 5 minutes

    const result = await prisma.rateLimitRecord.deleteMany({
      where: {
        createdAt: { lt: cutoffDate },
      },
    });

    if (result.count > 0) {
      logger.debug('Cleaned up old rate limit records', {
        count: result.count,
      });
    }
  } catch (error) {
    logger.error('Error cleaning up rate limit records', {
      error: error.message,
    });
  }
}

/**
 * Database rate limit middleware factory
 */
export function databaseRateLimit(options = {}) {
  const {
    windowMs = 60 * 1000, // 1 minute default
    max = 100, // 100 requests default
    message = 'Too many requests. Please try again later.',
  } = options;

  // Cleanup old records periodically (every 5 minutes)
  setInterval(cleanupOldRecords, 5 * 60 * 1000);

  return async (req, res, next) => {
    // Get store ID for key generation
    let key = 'global'; // Fallback key
    try {
      const storeId = getStoreId(req);
      key = `store:${storeId}`;
    } catch {
      // If store ID not available, use IP
      key = `ip:${req.ip || 'unknown'}`;
    }

    try {
      // Calculate window start time
      const windowStart = new Date(Date.now() - windowMs);

      // Count requests in current window
      const count = await prisma.rateLimitRecord.count({
        where: {
          key,
          createdAt: { gte: windowStart },
        },
      });

      // Check if limit exceeded
      if (count >= max) {
        // Get remaining time in window
        const oldestRecord = await prisma.rateLimitRecord.findFirst({
          where: {
            key,
            createdAt: { gte: windowStart },
          },
          orderBy: { createdAt: 'asc' },
        });

        const retryAfter = oldestRecord
          ? Math.ceil(
            (windowMs - (Date.now() - oldestRecord.createdAt.getTime())) /
                1000,
          )
          : Math.ceil(windowMs / 1000);

        res.setHeader('Retry-After', retryAfter);
        res.setHeader('X-RateLimit-Limit', max);
        res.setHeader('X-RateLimit-Remaining', 0);
        res.setHeader(
          'X-RateLimit-Reset',
          new Date(Date.now() + retryAfter * 1000).toISOString(),
        );

        return res.status(429).json({
          success: false,
          error: 'rate_limit_exceeded',
          message,
          retryAfter,
        });
      }

      // Record this request
      await prisma.rateLimitRecord.create({
        data: {
          key,
          createdAt: new Date(),
        },
      });

      // Set rate limit headers
      res.setHeader('X-RateLimit-Limit', max);
      res.setHeader('X-RateLimit-Remaining', Math.max(0, max - count - 1));
      res.setHeader(
        'X-RateLimit-Reset',
        new Date(Date.now() + windowMs).toISOString(),
      );

      next();
    } catch (error) {
      logger.error('Database rate limit error', {
        error: error.message,
        key,
      });

      // On error, allow request (fail open)
      next();
    }
  };
}

/**
 * Predefined database rate limiters (matching Redis-based ones)
 */

// General API rate limit
export const dbGeneralRateLimit = databaseRateLimit({
  windowMs: 60 * 1000,
  max: 100,
});

// Contacts rate limit
export const dbContactsRateLimit = databaseRateLimit({
  windowMs: 60 * 1000,
  max: 60,
});

// Campaigns rate limit
export const dbCampaignsRateLimit = databaseRateLimit({
  windowMs: 60 * 1000,
  max: 40,
});

// Campaign send rate limit (very strict)
export const dbCampaignSendRateLimit = databaseRateLimit({
  windowMs: 60 * 1000,
  max: 5,
});

// Billing rate limit
export const dbBillingRateLimit = databaseRateLimit({
  windowMs: 60 * 1000,
  max: 20,
});

// Import rate limit (very strict)
export const dbImportRateLimit = databaseRateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 3,
});

// Reports rate limits
export const dbReportsOverviewRateLimit = databaseRateLimit({
  windowMs: 60 * 1000,
  max: 50,
});

export const dbReportsGeneralRateLimit = databaseRateLimit({
  windowMs: 60 * 1000,
  max: 30,
});

export const dbReportsExportRateLimit = databaseRateLimit({
  windowMs: 60 * 1000,
  max: 10,
});

export default {
  databaseRateLimit,
  dbGeneralRateLimit,
  dbContactsRateLimit,
  dbCampaignsRateLimit,
  dbCampaignSendRateLimit,
  dbBillingRateLimit,
  dbImportRateLimit,
  dbReportsOverviewRateLimit,
  dbReportsGeneralRateLimit,
  dbReportsExportRateLimit,
};
