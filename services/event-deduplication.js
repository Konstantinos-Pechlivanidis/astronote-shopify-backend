import prisma from './prisma.js';
import { logger } from '../utils/logger.js';

// In-memory cache for processed event IDs (24 hour TTL)
// Format: { eventId: timestamp }
const processedEventsCache = new Map();

// Cache cleanup interval (24 hours)
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

/**
 * Clean up old entries from the cache
 */
function cleanupCache() {
  const now = Date.now();
  for (const [eventId, timestamp] of processedEventsCache.entries()) {
    if (now - timestamp > CACHE_TTL) {
      processedEventsCache.delete(eventId);
    }
  }
}

// Run cleanup every hour
setInterval(cleanupCache, 60 * 60 * 1000);

/**
 * Get last processed event state for a shop and automation type
 * @param {string} shopId - Shop ID
 * @param {string} automationType - Automation type
 * @returns {Promise<Object|null>} Last processed event state or null
 */
export async function getLastProcessedEvent(shopId, automationType) {
  try {
    const state = await prisma.eventProcessingState.findUnique({
      where: {
        shopId_automationType: {
          shopId,
          automationType,
        },
      },
    });

    return state;
  } catch (error) {
    logger.error('Failed to get last processed event', {
      shopId,
      automationType,
      error: error.message,
    });
    throw error;
  }
}

/**
 * Update last processed event state
 * @param {string} shopId - Shop ID
 * @param {string} automationType - Automation type
 * @param {string} eventId - Event GID
 * @param {Date} occurredAt - Event occurred timestamp
 * @returns {Promise<Object>} Updated state
 */
export async function updateLastProcessedEvent(
  shopId,
  automationType,
  eventId,
  occurredAt,
) {
  try {
    const state = await prisma.eventProcessingState.upsert({
      where: {
        shopId_automationType: {
          shopId,
          automationType,
        },
      },
      update: {
        lastEventId: eventId,
        lastProcessedAt: occurredAt || new Date(),
        updatedAt: new Date(),
      },
      create: {
        shopId,
        automationType,
        lastEventId: eventId,
        lastProcessedAt: occurredAt || new Date(),
      },
    });

    // Also add to in-memory cache
    processedEventsCache.set(eventId, Date.now());

    logger.debug('Updated last processed event', {
      shopId,
      automationType,
      eventId,
      occurredAt,
    });

    return state;
  } catch (error) {
    logger.error('Failed to update last processed event', {
      shopId,
      automationType,
      eventId,
      error: error.message,
    });
    throw error;
  }
}

/**
 * Check if event has already been processed
 * @param {string} eventId - Event GID
 * @param {string} shopId - Shop ID
 * @param {string} automationType - Automation type
 * @returns {Promise<boolean>} True if already processed
 */
export async function isEventProcessed(eventId, shopId, automationType) {
  try {
    // First check in-memory cache
    if (processedEventsCache.has(eventId)) {
      logger.debug('Event found in cache (already processed)', {
        eventId,
        shopId,
        automationType,
      });
      return true;
    }

    // Check database for last processed event
    const lastState = await getLastProcessedEvent(shopId, automationType);
    if (lastState && lastState.lastEventId === eventId) {
      // Add to cache
      processedEventsCache.set(eventId, Date.now());
      return true;
    }

    return false;
  } catch (error) {
    logger.error('Failed to check if event is processed', {
      eventId,
      shopId,
      automationType,
      error: error.message,
    });
    // On error, assume not processed to avoid missing events
    return false;
  }
}

/**
 * Mark event as processed in cache
 * @param {string} eventId - Event GID
 */
export function markEventAsProcessed(eventId) {
  processedEventsCache.set(eventId, Date.now());
}

/**
 * Get minimum occurredAt timestamp for querying events
 * @param {string} shopId - Shop ID
 * @param {string} automationType - Automation type
 * @param {number} fallbackMinutes - Fallback minutes if no last processed event (default: 10)
 * @returns {Promise<Date>} Minimum timestamp
 */
export async function getMinOccurredAt(
  shopId,
  automationType,
  fallbackMinutes = 10,
) {
  try {
    const lastState = await getLastProcessedEvent(shopId, automationType);
    if (lastState && lastState.lastProcessedAt) {
      // Use last processed time, but go back 1 minute to ensure we don't miss events
      const minTime = new Date(lastState.lastProcessedAt);
      minTime.setMinutes(minTime.getMinutes() - 1);
      return minTime;
    }

    // No previous state, use fallback
    const fallbackTime = new Date();
    fallbackTime.setMinutes(fallbackTime.getMinutes() - fallbackMinutes);
    return fallbackTime;
  } catch (error) {
    logger.error('Failed to get min occurredAt', {
      shopId,
      automationType,
      error: error.message,
    });
    // On error, use fallback
    const fallbackTime = new Date();
    fallbackTime.setMinutes(fallbackTime.getMinutes() - fallbackMinutes);
    return fallbackTime;
  }
}

/**
 * Batch mark events as processed
 * @param {Array<Object>} events - Array of events with { id, occurredAt }
 * @param {string} shopId - Shop ID
 * @param {string} automationType - Automation type
 */
export async function batchMarkEventsProcessed(events, shopId, automationType) {
  if (!events || events.length === 0) {
    return;
  }

  try {
    // Get the latest event
    const latestEvent = events.reduce((latest, current) => {
      const currentTime = new Date(current.occurredAt || 0);
      const latestTime = new Date(latest.occurredAt || 0);
      return currentTime > latestTime ? current : latest;
    });

    // Update database with latest event
    await updateLastProcessedEvent(
      shopId,
      automationType,
      latestEvent.id,
      latestEvent.occurredAt ? new Date(latestEvent.occurredAt) : new Date(),
    );

    // Mark all events in cache
    events.forEach(event => {
      if (event.id) {
        processedEventsCache.set(event.id, Date.now());
      }
    });

    logger.debug('Batch marked events as processed', {
      shopId,
      automationType,
      count: events.length,
      latestEventId: latestEvent.id,
    });
  } catch (error) {
    logger.error('Failed to batch mark events as processed', {
      shopId,
      automationType,
      error: error.message,
    });
    throw error;
  }
}

export default {
  getLastProcessedEvent,
  updateLastProcessedEvent,
  isEventProcessed,
  markEventAsProcessed,
  getMinOccurredAt,
  batchMarkEventsProcessed,
};
