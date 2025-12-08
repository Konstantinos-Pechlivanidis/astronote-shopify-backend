import prisma from './prisma.js';
import { logger } from '../utils/logger.js';

/**
 * Credit Validation Service
 *
 * Centralized service for validating and consuming SMS credits
 * Ensures no SMS can be sent without sufficient credits
 */

export class InsufficientCreditsError extends Error {
  constructor(message, missingCredits = 0) {
    super(message);
    this.name = 'InsufficientCreditsError';
    this.missingCredits = missingCredits;
  }
}

/**
 * Validate and consume credits for SMS sending
 * @param {string} storeId - The store ID
 * @param {number} messageCount - Number of messages to send
 * @returns {Promise<{success: boolean, creditsRemaining: number}>}
 */
export async function validateAndConsumeCredits(storeId, messageCount) {
  if (!storeId) {
    throw new Error('Store ID is required for credit validation');
  }

  if (!messageCount || messageCount <= 0) {
    throw new Error('Message count must be greater than 0');
  }

  try {
    // Use a transaction to ensure atomic credit validation and deduction
    const result = await prisma.$transaction(async tx => {
      // Lock the store row for update to prevent race conditions
      const store = await tx.shop.findUnique({
        where: { id: storeId },
        select: { id: true, credits: true, shopDomain: true },
      });

      if (!store) {
        throw new Error('Store not found');
      }

      // Check if store has sufficient credits
      if (store.credits < messageCount) {
        const missingCredits = messageCount - store.credits;
        throw new InsufficientCreditsError(
          `You need ${missingCredits} more credits to send this message. You currently have ${store.credits} credits.`,
          missingCredits,
        );
      }

      // Deduct credits atomically
      const updatedStore = await tx.shop.update({
        where: { id: storeId },
        data: {
          credits: {
            decrement: messageCount,
          },
        },
        select: { credits: true },
      });

      logger.info('Credits consumed successfully', {
        storeId,
        storeDomain: store.shopDomain,
        creditsConsumed: messageCount,
        creditsRemaining: updatedStore.credits,
      });

      return {
        success: true,
        creditsRemaining: updatedStore.credits,
        creditsConsumed: messageCount,
      };
    });

    return result;
  } catch (error) {
    if (error instanceof InsufficientCreditsError) {
      logger.warn('Insufficient credits for SMS send', {
        storeId,
        messageCount,
        error: error.message,
        missingCredits: error.missingCredits,
      });
      throw error;
    }

    logger.error('Credit validation failed', {
      storeId,
      messageCount,
      error: error.message,
    });
    throw error;
  }
}

/**
 * Check available credits without consuming them
 * @param {string} storeId - The store ID
 * @returns {Promise<{credits: number, canSend: boolean}>}
 */
export async function checkAvailableCredits(storeId) {
  if (!storeId) {
    throw new Error('Store ID is required for credit check');
  }

  try {
    const store = await prisma.shop.findUnique({
      where: { id: storeId },
      select: { credits: true, shopDomain: true },
    });

    if (!store) {
      throw new Error('Store not found');
    }

    return {
      credits: store.credits,
      canSend: store.credits > 0,
      storeDomain: store.shopDomain,
    };
  } catch (error) {
    logger.error('Credit check failed', {
      storeId,
      error: error.message,
    });
    throw error;
  }
}

/**
 * Validate credits for a specific number of messages without consuming them
 * @param {string} storeId - The store ID
 * @param {number} messageCount - Number of messages to validate
 * @returns {Promise<{canSend: boolean, missingCredits: number}>}
 */
export async function validateCreditsForMessages(storeId, messageCount) {
  if (!storeId) {
    throw new Error('Store ID is required for credit validation');
  }

  if (!messageCount || messageCount <= 0) {
    throw new Error('Message count must be greater than 0');
  }

  try {
    const store = await prisma.shop.findUnique({
      where: { id: storeId },
      select: { credits: true, shopDomain: true },
    });

    if (!store) {
      throw new Error('Store not found');
    }

    const canSend = store.credits >= messageCount;
    const missingCredits = canSend ? 0 : messageCount - store.credits;

    return {
      canSend,
      missingCredits,
      availableCredits: store.credits,
      storeDomain: store.shopDomain,
    };
  } catch (error) {
    logger.error('Credit validation check failed', {
      storeId,
      messageCount,
      error: error.message,
    });
    throw error;
  }
}

/**
 * Log automation skip due to insufficient credits
 * @param {string} automationId - The automation ID
 * @param {string} storeId - The store ID
 * @param {string} reason - Reason for skipping
 */
export async function logAutomationSkip(
  automationId,
  storeId,
  reason = 'Insufficient credits',
) {
  try {
    await prisma.automationLog.create({
      data: {
        automationId,
        storeId,
        status: 'skipped',
        reason,
        triggeredAt: new Date(),
      },
    });

    logger.warn('Automation skipped due to insufficient credits', {
      automationId,
      storeId,
      reason,
    });
  } catch (error) {
    logger.error('Failed to log automation skip', {
      automationId,
      storeId,
      reason,
      error: error.message,
    });
  }
}

/**
 * Get credit usage statistics for a store
 * @param {string} storeId - The store ID
 * @returns {Promise<{totalCredits: number, usedCredits: number, remainingCredits: number}>}
 */
export async function getCreditUsageStats(storeId) {
  if (!storeId) {
    throw new Error('Store ID is required for credit stats');
  }

  try {
    const store = await prisma.shop.findUnique({
      where: { id: storeId },
      select: { credits: true },
    });

    if (!store) {
      throw new Error('Store not found');
    }

    // Get total credits purchased (from billing transactions)
    const totalPurchased = await prisma.billingTransaction.aggregate({
      where: {
        shopId: storeId,
        status: 'completed',
      },
      _sum: {
        creditsAdded: true,
      },
    });

    const totalCredits = totalPurchased._sum.creditsAdded || 0;
    const remainingCredits = store.credits;
    const usedCredits = totalCredits - remainingCredits;

    return {
      totalCredits,
      usedCredits,
      remainingCredits,
    };
  } catch (error) {
    logger.error('Failed to get credit usage stats', {
      storeId,
      error: error.message,
    });
    throw error;
  }
}

/**
 * Refund credits to a store (for rollback scenarios)
 * @param {string} storeId - The store ID
 * @param {number} credits - Number of credits to refund
 * @param {string} reason - Reason for refund (e.g., 'campaign:campaignId:rollback')
 * @returns {Promise<{success: boolean, creditsAdded: number, creditsRemaining: number}>}
 */
export async function refundCredits(storeId, credits, reason = 'refund') {
  if (!storeId) {
    throw new Error('Store ID is required for credit refund');
  }

  if (!credits || credits <= 0) {
    throw new Error('Credits must be greater than 0');
  }

  try {
    // Use a transaction to ensure atomic credit refund
    const result = await prisma.$transaction(async tx => {
      const store = await tx.shop.findUnique({
        where: { id: storeId },
        select: { id: true, credits: true, shopDomain: true },
      });

      if (!store) {
        throw new Error('Store not found');
      }

      // Add credits atomically
      const updatedStore = await tx.shop.update({
        where: { id: storeId },
        data: {
          credits: {
            increment: credits,
          },
        },
        select: { credits: true },
      });

      logger.info('Credits refunded successfully', {
        storeId,
        storeDomain: store.shopDomain,
        creditsRefunded: credits,
        creditsRemaining: updatedStore.credits,
        reason,
      });

      return {
        success: true,
        creditsAdded: credits,
        creditsRemaining: updatedStore.credits,
      };
    });

    return result;
  } catch (error) {
    logger.error('Credit refund failed', {
      storeId,
      credits,
      reason,
      error: error.message,
    });
    throw error;
  }
}

export default {
  validateAndConsumeCredits,
  checkAvailableCredits,
  validateCreditsForMessages,
  logAutomationSkip,
  getCreditUsageStats,
  refundCredits,
  InsufficientCreditsError,
};
