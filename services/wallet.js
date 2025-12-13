import prisma from './prisma.js';
import { logger } from '../utils/logger.js';
import { ValidationError } from '../utils/errors.js';

/**
 * Wallet Service
 * Handles credit management with atomic transactions and CreditTransaction creation
 * Adapted for Shopify (shopId-based instead of userId-based)
 */

/**
 * Ensure a wallet row exists for the shop. Returns wallet.
 * Uses upsert to avoid race conditions.
 */
export async function ensureWallet(shopId) {
  return prisma.wallet.upsert({
    where: { shopId },
    update: {},
    create: { shopId, balance: 0 },
  });
}

/**
 * Get current balance (ensures wallet exists).
 */
export async function getBalance(shopId) {
  const wallet = await ensureWallet(shopId);
  return wallet.balance;
}

/**
 * Internal helper to append a transaction & update wallet balance atomically.
 * Can be used within an existing transaction by passing tx parameter.
 */
async function appendTxnAndUpdate(
  shopId,
  delta,
  type,
  { reason, campaignId, messageId, meta } = {},
  tx = null,
) {
  const execute = async client => {
    const wallet = await client.wallet.upsert({
      where: { shopId },
      update: {},
      create: { shopId, balance: 0 },
      select: { id: true, balance: true },
    });

    const newBalance = wallet.balance + delta;
    if (newBalance < 0) {
      logger.warn(
        { shopId, currentBalance: wallet.balance, delta, type },
        'Insufficient credits',
      );
      throw new ValidationError('Insufficient credits');
    }

    // Update wallet
    await client.wallet.update({
      where: { shopId },
      data: { balance: newBalance },
    });

    // Insert transaction
    const txn = await client.creditTransaction.create({
      data: {
        shopId,
        type,
        amount: Math.abs(delta), // always positive in record
        balanceAfter: newBalance,
        reason: reason || null,
        campaignId: campaignId || null,
        messageId: messageId || null,
        meta: meta || undefined,
        walletId: wallet.id, // Link to wallet for referential integrity
      },
    });

    logger.info(
      {
        shopId,
        type,
        amount: Math.abs(delta),
        balanceAfter: newBalance,
        reason,
      },
      'Wallet transaction completed',
    );

    return { balance: newBalance, txn };
  };

  // If already in a transaction, use it; otherwise create a new one
  if (tx) {
    return execute(tx);
  } else {
    return prisma.$transaction(execute);
  }
}

/**
 * Credit (top-up/purchase/admin grant). Positive amount.
 * Can be used within an existing transaction by passing tx parameter.
 */
export async function credit(shopId, amount, opts = {}, tx = null) {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new ValidationError('Invalid amount: must be a positive integer');
  }
  return appendTxnAndUpdate(shopId, +amount, 'credit', opts, tx);
}

/**
 * Debit (consume). Positive amount. Throws on insufficient credits.
 * Can be used within an existing transaction by passing tx parameter.
 */
export async function debit(shopId, amount, opts = {}, tx = null) {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new ValidationError('Invalid amount: must be a positive integer');
  }
  return appendTxnAndUpdate(shopId, -amount, 'debit', opts, tx);
}

/**
 * Refund (give back). Positive amount.
 * Can be used within an existing transaction by passing tx parameter.
 */
export async function refund(shopId, amount, opts = {}, tx = null) {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new ValidationError('Invalid amount: must be a positive integer');
  }
  return appendTxnAndUpdate(shopId, +amount, 'refund', opts, tx);
}

/**
 * Create a credit transaction record without updating balance
 * Useful for tracking purposes or when balance is updated separately
 */
export async function createCreditTransaction(
  shopId,
  type,
  amount,
  reason,
  meta = {},
  tx = null,
) {
  const execute = async client => {
    const wallet = await ensureWallet(shopId);
    const txn = await client.creditTransaction.create({
      data: {
        shopId,
        type,
        amount: Math.abs(amount),
        balanceAfter: wallet.balance, // Current balance at time of transaction
        reason: reason || null,
        meta: meta || undefined,
        walletId: wallet.id,
      },
    });

    logger.info(
      { shopId, type, amount: Math.abs(amount), reason },
      'Credit transaction created',
    );

    return txn;
  };

  if (tx) {
    return execute(tx);
  } else {
    return prisma.$transaction(execute);
  }
}

/**
 * Reserve credits for a campaign (prevents credit depletion mid-campaign)
 * Credits are reserved but not debited until messages are actually sent
 * @param {string} shopId - Shop ID
 * @param {number} amount - Amount of credits to reserve
 * @param {Object} options - Reservation options
 * @param {string} [options.campaignId] - Campaign ID (optional)
 * @param {Date} [options.expiresAt] - Expiration date (default: 24h from now)
 * @param {Object} [options.meta] - Additional metadata
 * @param {Object} [tx] - Optional transaction context
 * @returns {Promise<Object>} Reservation object with id
 */
export async function reserveCredits(
  shopId,
  amount,
  options = {},
  tx = null,
) {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new ValidationError('Invalid amount: must be a positive integer');
  }

  const { campaignId, expiresAt, meta } = options;

  const execute = async client => {
    // Ensure wallet exists
    const wallet = await client.wallet.upsert({
      where: { shopId },
      update: {},
      create: { shopId, balance: 0 },
      select: { id: true, balance: true },
    });

    // Check if sufficient balance (including existing reservations)
    const activeReservations = await client.creditReservation.aggregate({
      where: {
        shopId,
        status: 'active',
      },
      _sum: {
        amount: true,
      },
    });

    const reservedAmount = activeReservations._sum.amount || 0;
    const availableBalance = wallet.balance - reservedAmount;

    if (availableBalance < amount) {
      logger.warn(
        {
          shopId,
          balance: wallet.balance,
          reserved: reservedAmount,
          available: availableBalance,
          requested: amount,
        },
        'Insufficient credits for reservation',
      );
      throw new ValidationError(
        `Insufficient credits. Available: ${availableBalance}, Requested: ${amount}`,
      );
    }

    // Create reservation
    const reservation = await client.creditReservation.create({
      data: {
        shopId,
        campaignId: campaignId || null,
        amount,
        status: 'active',
        expiresAt: expiresAt || new Date(Date.now() + 24 * 60 * 60 * 1000), // 24h default
        meta: meta || undefined,
      },
    });

    logger.info(
      {
        shopId,
        reservationId: reservation.id,
        amount,
        campaignId,
        expiresAt: reservation.expiresAt,
      },
      'Credits reserved',
    );

    return reservation;
  };

  if (tx) {
    return execute(tx);
  } else {
    return prisma.$transaction(execute);
  }
}

/**
 * Release reserved credits (when campaign completes or fails)
 * @param {string} reservationId - Reservation ID
 * @param {Object} [options] - Release options
 * @param {string} [options.reason] - Reason for release
 * @param {Object} [tx] - Optional transaction context
 * @returns {Promise<Object>} Updated reservation
 */
export async function releaseCredits(reservationId, options = {}, tx = null) {
  const { reason } = options;

  const execute = async client => {
    const reservation = await client.creditReservation.findUnique({
      where: { id: reservationId },
    });

    if (!reservation) {
      logger.warn({ reservationId }, 'Reservation not found');
      throw new ValidationError('Reservation not found');
    }

    if (reservation.status !== 'active') {
      logger.warn(
        { reservationId, status: reservation.status },
        'Reservation already released or expired',
      );
      return reservation; // Already released, return as-is
    }

    // Update reservation status
    const updated = await client.creditReservation.update({
      where: { id: reservationId },
      data: {
        status: 'released',
        releasedAt: new Date(),
        meta: {
          ...(reservation.meta || {}),
          releaseReason: reason || 'campaign_completed',
        },
      },
    });

    logger.info(
      {
        shopId: reservation.shopId,
        reservationId,
        amount: reservation.amount,
        campaignId: reservation.campaignId,
        reason,
      },
      'Credits reservation released',
    );

    return updated;
  };

  if (tx) {
    return execute(tx);
  } else {
    return prisma.$transaction(execute);
  }
}

/**
 * Get available balance (total balance minus active reservations)
 * @param {string} shopId - Shop ID
 * @returns {Promise<number>} Available balance
 */
export async function getAvailableBalance(shopId) {
  const wallet = await ensureWallet(shopId);

  const activeReservations = await prisma.creditReservation.aggregate({
    where: {
      shopId,
      status: 'active',
    },
    _sum: {
      amount: true,
    },
  });

  const reservedAmount = activeReservations._sum.amount || 0;
  return wallet.balance - reservedAmount;
}

export default {
  ensureWallet,
  getBalance,
  getAvailableBalance,
  credit,
  debit,
  refund,
  createCreditTransaction,
  reserveCredits,
  releaseCredits,
};
