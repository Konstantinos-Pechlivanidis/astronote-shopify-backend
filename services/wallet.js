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

export default {
  ensureWallet,
  getBalance,
  credit,
  debit,
  refund,
  createCreditTransaction,
};
