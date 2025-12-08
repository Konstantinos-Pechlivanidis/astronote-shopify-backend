import prisma from './prisma.js';
import { logger } from '../utils/logger.js';
import { ValidationError, NotFoundError } from '../utils/errors.js';
import { createStripeCheckoutSession, getStripePriceId } from './stripe.js';
import {
  credit,
  debit,
  refund as refundCredits,
  getBalance as getWalletBalance,
} from './wallet.js';

/**
 * Billing Service
 * Handles credit management, Stripe integration, and transaction history
 */

/**
 * Credit packages configuration (deprecated - now using Package model)
 * @deprecated Use Package model from database instead
 */
/*
const CREDIT_PACKAGES = [
  {
    id: 'package_1000',
    name: '1,000 SMS Credits',
    credits: 1000,
    priceEUR: 29.99,
    priceUSD: 32.99,
    stripePriceIdEUR: process.env.STRIPE_PRICE_ID_1000_EUR || 'price_1000_credits_eur',
    stripePriceIdUSD: process.env.STRIPE_PRICE_ID_1000_USD || 'price_1000_credits_usd',
    description: 'Perfect for small businesses getting started',
    popular: false,
    features: ['1,000 SMS messages', 'No expiration', 'Priority support'],
  },
  {
    id: 'package_5000',
    name: '5,000 SMS Credits',
    credits: 5000,
    priceEUR: 129.99,
    priceUSD: 142.99,
    stripePriceIdEUR: process.env.STRIPE_PRICE_ID_5000_EUR || 'price_5000_credits_eur',
    stripePriceIdUSD: process.env.STRIPE_PRICE_ID_5000_USD || 'price_5000_credits_usd',
    description: 'Great value for growing businesses',
    popular: true,
    features: ['5,000 SMS messages', 'No expiration', 'Priority support', '13% savings'],
  },
  {
    id: 'package_10000',
    name: '10,000 SMS Credits',
    credits: 10000,
    priceEUR: 229.99,
    priceUSD: 252.99,
    stripePriceIdEUR: process.env.STRIPE_PRICE_ID_10000_EUR || 'price_10000_credits_eur',
    stripePriceIdUSD: process.env.STRIPE_PRICE_ID_10000_USD || 'price_10000_credits_usd',
    description: 'Best value for high-volume senders',
    popular: false,
    features: ['10,000 SMS messages', 'No expiration', 'Priority support', '23% savings'],
  },
  {
    id: 'package_25000',
    name: '25,000 SMS Credits',
    credits: 25000,
    priceEUR: 499.99,
    priceUSD: 549.99,
    stripePriceIdEUR: process.env.STRIPE_PRICE_ID_25000_EUR || 'price_25000_credits_eur',
    stripePriceIdUSD: process.env.STRIPE_PRICE_ID_25000_USD || 'price_25000_credits_usd',
    description: 'Enterprise solution for maximum reach',
    popular: false,
    features: ['25,000 SMS messages', 'No expiration', 'Dedicated support', '33% savings'],
  },
];
*/

/**
 * Get credit balance for store
 * @param {string} storeId - Store ID
 * @returns {Promise<Object>} Balance information
 */
export async function getBalance(storeId) {
  logger.info('Getting balance', { storeId });

  const shop = await prisma.shop.findUnique({
    where: { id: storeId },
    select: { currency: true },
  });

  if (!shop) {
    throw new NotFoundError('Shop');
  }

  // Use Wallet service instead of Shop.credits
  const balance = await getWalletBalance(storeId);

  logger.info('Balance retrieved', { storeId, credits: balance });

  return {
    credits: balance,
    balance, // Alias for consistency
    currency: shop.currency || 'EUR',
  };
}

/**
 * Get available credit packages from database
 * @param {string} currency - Currency code (EUR or USD), defaults to EUR
 * @returns {Promise<Array>} Available packages with currency-specific pricing
 */
export async function getPackages(currency = 'EUR') {
  logger.info('Getting credit packages', { currency });

  const packages = await prisma.package.findMany({
    where: { active: true },
    orderBy: { units: 'asc' },
  });

  return packages.map(pkg => ({
    id: pkg.id,
    name: pkg.name,
    credits: pkg.units,
    price: (pkg.priceCents / 100).toFixed(2),
    currency,
    // Get Stripe price ID for this currency
    stripePriceId:
      currency === 'USD' ? pkg.stripePriceIdUsd : pkg.stripePriceIdEur,
  }));
}

/**
 * Get package by ID from database
 * @param {string} packageId - Package ID
 * @returns {Promise<Object>} Package details
 */
export async function getPackageById(packageId) {
  const pkg = await prisma.package.findUnique({
    where: { id: packageId },
  });

  if (!pkg) {
    throw new NotFoundError('Package');
  }

  if (!pkg.active) {
    throw new ValidationError('Package is not active');
  }

  return pkg;
}

/**
 * Create Stripe checkout session for credit purchase
 * @param {string} storeId - Store ID
 * @param {string} packageId - Package ID
 * @param {Object} returnUrls - Success and cancel URLs
 * @returns {Promise<Object>} Checkout session
 */
export async function createPurchaseSession(
  storeId,
  packageId,
  returnUrls,
  requestedCurrency = null,
) {
  logger.info('Creating purchase session', {
    storeId,
    packageId,
    requestedCurrency,
  });

  // Validate package
  let pkg;
  try {
    pkg = await getPackageById(packageId);
    logger.debug('Package found', { packageId, credits: pkg.units });
  } catch (packageError) {
    logger.error('Invalid package ID', {
      packageId,
      error: packageError.message,
    });
    throw packageError;
  }

  // Get shop details with currency
  let shop;
  try {
    shop = await prisma.shop.findUnique({
      where: { id: storeId },
      select: { id: true, shopDomain: true, shopName: true, currency: true },
    });

    if (!shop) {
      logger.error('Shop not found in database', { storeId });
      throw new NotFoundError('Shop');
    }

    logger.debug('Shop found', {
      storeId,
      shopDomain: shop.shopDomain,
      currency: shop.currency,
    });
  } catch (shopError) {
    logger.error('Failed to retrieve shop', {
      storeId,
      error: shopError.message,
    });
    throw shopError;
  }

  // Validate return URLs
  if (!returnUrls.successUrl || !returnUrls.cancelUrl) {
    throw new ValidationError('Success and cancel URLs are required');
  }

  // Select currency: use requested currency if provided and valid, otherwise use shop currency, fallback to EUR
  // Only allow EUR or USD
  const validCurrencies = ['EUR', 'USD'];
  let currency = 'EUR';

  if (
    requestedCurrency &&
    validCurrencies.includes(requestedCurrency.toUpperCase())
  ) {
    currency = requestedCurrency.toUpperCase();
  } else if (
    shop.currency &&
    validCurrencies.includes(shop.currency.toUpperCase())
  ) {
    currency = shop.currency.toUpperCase();
  }

  const price = pkg.priceCents / 100; // Convert from cents
  const stripePriceId = getStripePriceId(pkg.name, currency, pkg);

  // Validate Stripe price ID
  if (!stripePriceId) {
    logger.error('Missing Stripe price ID', {
      currency,
      packageId,
      packageName: pkg.name,
    });
    throw new ValidationError(
      `Stripe price ID is not configured for ${currency}. Please set the price ID in the Package model or environment variable.`,
    );
  }

  logger.debug('Stripe configuration', {
    currency,
    price,
    stripePriceId,
    packageId,
  });

  // Create Purchase record instead of BillingTransaction
  const purchase = await prisma.purchase.create({
    data: {
      shopId: storeId,
      packageId: pkg.id,
      units: pkg.units,
      priceCents: pkg.priceCents,
      status: 'pending',
      currency,
      stripePriceId,
    },
  });

  // Create Stripe checkout session
  let session;
  try {
    logger.debug('Calling Stripe checkout session creation', {
      storeId,
      shopDomain: shop.shopDomain,
      packageId,
      stripePriceId,
      currency,
    });

    session = await createStripeCheckoutSession({
      packageId: pkg.id,
      credits: pkg.units,
      price,
      currency,
      stripePriceId, // Use selected price ID based on currency
      shopId: storeId,
      shopDomain: shop.shopDomain,
      successUrl: returnUrls.successUrl,
      cancelUrl: returnUrls.cancelUrl,
      metadata: {
        storeId,
        shopId: storeId, // Keep for backward compatibility
        packageId: pkg.id,
        purchaseId: purchase.id,
        credits: pkg.units.toString(),
        type: 'credit_pack', // Mark as credit pack purchase
      },
    });

    logger.debug('Stripe checkout session created', {
      sessionId: session?.id,
      sessionUrl: session?.url,
    });
  } catch (stripeError) {
    logger.error('Failed to create Stripe checkout session', {
      error: stripeError.message,
      errorName: stripeError.name,
      errorStack: stripeError.stack,
      storeId,
      packageId,
      stripePriceId,
      currency,
    });

    // Clean up the purchase record if Stripe session creation fails
    try {
      await prisma.purchase.delete({
        where: { id: purchase.id },
      });
      logger.debug('Cleaned up failed purchase record', {
        purchaseId: purchase.id,
      });
    } catch (cleanupError) {
      logger.warn('Failed to clean up purchase record', {
        purchaseId: purchase.id,
        error: cleanupError.message,
      });
    }

    throw stripeError;
  }

  // Update purchase with Stripe session ID
  await prisma.purchase.update({
    where: { id: purchase.id },
    data: {
      stripeSessionId: session.id,
      stripePaymentIntentId: session.payment_intent || null,
      stripeCustomerId: session.customer || null,
    },
  });

  logger.info('Purchase session created', {
    storeId,
    packageId,
    sessionId: session.id,
    purchaseId: purchase.id,
  });

  // Return package info
  const packageInfo = {
    id: pkg.id,
    name: pkg.name,
    credits: pkg.units,
    price: price.toFixed(2),
    currency,
  };

  return {
    sessionId: session.id,
    sessionUrl: session.url,
    purchaseId: purchase.id,
    package: packageInfo,
  };
}

/**
 * Handle successful Stripe payment
 * @param {Object} stripeEvent - Stripe webhook event
 * @returns {Promise<Object>} Processing result
 */
export async function handleStripeWebhook(stripeEvent) {
  logger.info('Handling Stripe webhook', {
    type: stripeEvent.type,
    eventId: stripeEvent.id,
  });

  if (stripeEvent.type === 'checkout.session.completed') {
    const session = stripeEvent.data.object;
    const metadata = session.metadata || {};
    const type = metadata.type;

    // Skip subscription and top-up - they are handled in webhook controller
    if (type === 'subscription' || type === 'credit_topup') {
      logger.debug(
        'Skipping subscription/top-up in billing service (handled in webhook controller)',
        {
          sessionId: session.id,
          type,
        },
      );
      return { status: 'ignored', reason: 'handled_elsewhere' };
    }

    // Support both shopId and storeId (they are the same - shop.id)
    const storeId = metadata.storeId || metadata.shopId;
    const { purchaseId, packageId, credits } = metadata;

    if (!storeId) {
      logger.error('Missing storeId/shopId in session metadata', {
        sessionId: session.id,
        metadata: session.metadata,
      });
      throw new ValidationError('Missing storeId/shopId in session metadata');
    }

    if (!credits) {
      logger.error('Missing credits in session metadata', {
        sessionId: session.id,
        metadata: session.metadata,
      });
      throw new ValidationError('Missing credits in session metadata');
    }

    logger.info('Processing completed checkout', {
      storeId,
      purchaseId,
      sessionId: session.id,
    });

    // Find purchase record (matching retail-backend pattern)
    // First try with all constraints, then fallback to just session ID (for robustness)
    let purchase = null;
    if (purchaseId && packageId) {
      purchase = await prisma.purchase.findFirst({
        where: {
          id: purchaseId,
          shopId: storeId,
          packageId,
          status: 'pending',
        },
        include: { package: true },
      });
    }

    // Fallback: find by session ID with constraints
    if (!purchase) {
      purchase = await prisma.purchase.findFirst({
        where: {
          stripeSessionId: session.id,
          shopId: storeId,
          status: 'pending',
        },
        include: { package: true },
      });
    }

    // Final fallback: find by session ID only (in case metadata doesn't match exactly)
    if (!purchase) {
      purchase = await prisma.purchase.findFirst({
        where: {
          stripeSessionId: session.id,
          status: 'pending',
        },
        include: { package: true },
      });
    }

    if (!purchase) {
      logger.warn('Purchase record not found for completed checkout', {
        purchaseId,
        sessionId: session.id,
        shopId: storeId,
        packageId,
      });
      throw new NotFoundError('Purchase');
    }

    // Validate shopId matches if we found by session ID only (security check)
    if (purchase.shopId !== storeId) {
      logger.warn('Purchase shopId mismatch', {
        purchaseId: purchase.id,
        purchaseShopId: purchase.shopId,
        sessionShopId: storeId,
        sessionId: session.id,
      });
      throw new ValidationError('Purchase does not belong to this shop');
    }

    if (purchase.status === 'paid') {
      logger.warn('Purchase already completed', { purchaseId: purchase.id });
      return { status: 'already_processed' };
    }

    // Validate payment amount matches expected amount (fraud prevention)
    const expectedAmountCents = purchase.priceCents;
    const actualAmountCents = session.amount_total || 0;

    // Allow small rounding differences (up to 1 cent)
    if (Math.abs(actualAmountCents - expectedAmountCents) > 1) {
      logger.error(
        {
          shopId: storeId,
          sessionId: session.id,
          expectedAmountCents,
          actualAmountCents,
          purchaseId: purchase.id,
        },
        'Payment amount mismatch - potential fraud or configuration error',
      );
      throw new ValidationError(
        `Payment amount mismatch: expected ${expectedAmountCents} cents, got ${actualAmountCents} cents`,
      );
    }

    // Update purchase status and credit wallet atomically (like retail-backend)
    try {
      await prisma.$transaction(async tx => {
        // Update purchase status
        await tx.purchase.update({
          where: { id: purchase.id },
          data: {
            status: 'paid',
            stripePaymentIntentId: session.payment_intent || null,
            stripeCustomerId: session.customer || null,
            updatedAt: new Date(),
          },
        });

        // Credit wallet atomically (pass tx to avoid nested transaction)
        const { credit } = await import('./wallet.js');
        await credit(
          storeId,
          purchase.units,
          {
            reason: `stripe:purchase:${purchase.package.name}`,
            meta: {
              purchaseId: purchase.id,
              packageId: purchase.packageId,
              stripeSessionId: session.id,
              stripePaymentIntentId: session.payment_intent,
              currency: purchase.currency || 'EUR',
            },
          },
          tx,
        );
      });
    } catch (err) {
      logger.error(
        {
          err,
          purchaseId: purchase.id,
          shopId: storeId,
          units: purchase.units,
        },
        'Failed to process purchase completion',
      );
      throw err; // Re-throw to be caught by webhook handler
    }

    logger.info('Purchase completed successfully', {
      storeId,
      purchaseId: purchase.id,
      creditsAdded: credits,
    });

    return {
      status: 'success',
      storeId,
      creditsAdded: parseInt(credits),
    };
  }

  // Handle refund events
  if (
    stripeEvent.type === 'charge.refunded' ||
    stripeEvent.type === 'payment_intent.refunded'
  ) {
    const refund = stripeEvent.data.object;
    const paymentIntentId = refund.payment_intent || refund.id;

    logger.info('Processing refund webhook', {
      refundId: refund.id,
      paymentIntentId,
      amount: refund.amount,
      currency: refund.currency,
    });

    // Find the original purchase by payment intent ID
    const purchase = await prisma.purchase.findFirst({
      where: {
        stripePaymentIntentId: paymentIntentId,
        status: 'paid',
      },
      include: { package: true },
    });

    if (!purchase) {
      logger.warn('Purchase not found for refund', {
        paymentIntentId,
        refundId: refund.id,
      });
      // Don't throw - refund might be for a different system
      return { status: 'ignored', reason: 'purchase_not_found' };
    }

    // Calculate credits to refund (proportional if partial refund)
    const originalAmount = purchase.priceCents; // Amount in cents
    const refundAmount = refund.amount; // Refund amount in cents
    const creditsToRefund = Math.floor(
      (purchase.units * refundAmount) / originalAmount,
    );

    // Process refund
    await processRefund(
      purchase.shopId,
      purchase.id,
      creditsToRefund,
      refund.id,
      {
        paymentIntentId,
        refundAmount,
        originalAmount,
        currency: refund.currency,
      },
    );

    return {
      status: 'success',
      storeId: purchase.shopId,
      creditsRefunded: creditsToRefund,
    };
  }

  return { status: 'ignored', type: stripeEvent.type };
}

/**
 * Add credits to store balance using Wallet service
 * @param {string} storeId - Store ID
 * @param {number} credits - Credits to add
 * @param {string} ref - Reference (e.g., 'stripe:session_id')
 * @param {Object} meta - Additional metadata
 * @returns {Promise<Object>} Updated balance
 */
export async function addCredits(storeId, credits, ref, meta = {}) {
  logger.info('Adding credits', { storeId, credits, ref });

  if (credits <= 0) {
    throw new ValidationError('Credits must be positive');
  }

  // Use Wallet service instead of directly updating Shop.credits
  const result = await credit(storeId, credits, {
    reason: ref,
    meta,
  });

  logger.info('Credits added successfully', {
    storeId,
    creditsAdded: credits,
    newBalance: result.balance,
  });

  return {
    credits: result.balance,
    added: credits,
  };
}

/**
 * Deduct credits from store balance using Wallet service
 * @param {string} storeId - Store ID
 * @param {number} credits - Credits to deduct
 * @param {string} ref - Reference (e.g., 'campaign:campaign_id')
 * @param {Object} meta - Additional metadata
 * @returns {Promise<Object>} Updated balance
 */
export async function deductCredits(storeId, credits, ref, meta = {}) {
  logger.info('Deducting credits', { storeId, credits, ref });

  if (credits <= 0) {
    throw new ValidationError('Credits must be positive');
  }

  // Use Wallet service instead of directly updating Shop.credits
  const result = await debit(storeId, credits, {
    reason: ref,
    meta,
  });

  logger.info('Credits deducted successfully', {
    storeId,
    creditsDeducted: credits,
    newBalance: result.balance,
  });

  return {
    credits: result.balance,
    deducted: credits,
  };
}

/**
 * Process refund for a purchase
 * Deducts credits and creates refund transaction records
 * @param {string} storeId - Store ID
 * @param {string} transactionId - Original BillingTransaction ID
 * @param {number} creditsToRefund - Credits to refund (defaults to original amount)
 * @param {string} refundId - Stripe refund ID
 * @param {Object} meta - Additional metadata
 * @returns {Promise<Object>} Refund result
 */
export async function processRefund(
  storeId,
  transactionId,
  creditsToRefund = null,
  refundId = null,
  meta = {},
) {
  logger.info('Processing refund', {
    storeId,
    transactionId,
    creditsToRefund,
    refundId,
  });

  // Try to find Purchase first (new model), then fall back to BillingTransaction (legacy)
  const purchase = await prisma.purchase.findUnique({
    where: { id: transactionId },
  });

  let transaction = null;
  let credits = creditsToRefund;

  if (purchase) {
    // Using Purchase model
    if (purchase.shopId !== storeId) {
      logger.error('Purchase does not belong to store', {
        transactionId,
        storeId,
        purchaseShopId: purchase.shopId,
      });
      throw new ValidationError('Purchase does not belong to this store');
    }

    if (purchase.status !== 'paid') {
      logger.error('Cannot refund non-paid purchase', {
        transactionId,
        status: purchase.status,
      });
      throw new ValidationError('Can only refund paid purchases');
    }

    credits = creditsToRefund || purchase.units;
  } else {
    // Fallback to BillingTransaction (legacy)
    transaction = await prisma.billingTransaction.findUnique({
      where: { id: transactionId },
    });

    if (!transaction) {
      logger.error('Transaction not found for refund', { transactionId });
      throw new NotFoundError('Transaction');
    }

    if (transaction.shopId !== storeId) {
      logger.error('Transaction does not belong to store', {
        transactionId,
        storeId,
        transactionShopId: transaction.shopId,
      });
      throw new ValidationError('Transaction does not belong to this store');
    }

    if (transaction.status !== 'completed') {
      logger.error('Cannot refund non-completed transaction', {
        transactionId,
        status: transaction.status,
      });
      throw new ValidationError('Can only refund completed transactions');
    }

    credits = creditsToRefund || transaction.creditsAdded;
  }

  if (credits <= 0) {
    throw new ValidationError('Refund credits must be positive');
  }

  // Use Wallet service for refund
  const result = await refundCredits(storeId, credits, {
    reason: refundId ? `stripe:refund:${refundId}` : `refund:${transactionId}`,
    meta: {
      originalTransactionId: transactionId,
      refundId,
      ...meta,
    },
  });

  // Update Purchase or BillingTransaction status
  if (purchase) {
    await prisma.purchase.update({
      where: { id: purchase.id },
      data: { status: 'refunded' },
    });
    logger.info(
      {
        shopId: storeId,
        purchaseId: purchase.id,
      },
      'Purchase status updated to refunded',
    );
  } else if (transaction) {
    // Legacy: Update BillingTransaction (keep for backward compatibility)
    // Note: BillingTransaction doesn't have a refunded status, so we'll just log it
    logger.info(
      {
        shopId: storeId,
        transactionId: transaction.id,
      },
      'Legacy BillingTransaction refunded (status not updated)',
    );
  } else {
    // Fallback: Try to find Purchase by stripePaymentIntentId
    if (meta.paymentIntentId) {
      const purchaseByPayment = await prisma.purchase.findFirst({
        where: {
          shopId: storeId,
          stripePaymentIntentId: meta.paymentIntentId,
          status: 'paid',
        },
      });

      if (purchaseByPayment) {
        await prisma.purchase.update({
          where: { id: purchaseByPayment.id },
          data: { status: 'refunded' },
        });
        logger.info(
          {
            shopId: storeId,
            purchaseId: purchaseByPayment.id,
          },
          'Purchase found by payment intent and updated to refunded',
        );
      }
    }
  }

  logger.info('Refund processed successfully', {
    storeId,
    transactionId,
    creditsRefunded: credits,
    newBalance: result.balance,
  });

  return {
    credits: result.balance,
    refunded: credits,
    transactionId,
  };
}

/**
 * Get transaction history
 * @param {string} storeId - Store ID
 * @param {Object} filters - Filter options
 * @returns {Promise<Object>} Transaction history
 */
export async function getTransactionHistory(storeId, filters = {}) {
  const { page = 1, pageSize = 20, type, startDate, endDate } = filters;

  logger.info('Getting transaction history', { storeId, filters });

  const where = { shopId: storeId };

  if (
    type &&
    ['purchase', 'debit', 'credit', 'refund', 'adjustment'].includes(type)
  ) {
    where.type = type;
  }

  if (startDate || endDate) {
    where.createdAt = {};
    if (startDate) where.createdAt.gte = new Date(startDate);
    if (endDate) where.createdAt.lte = new Date(endDate);
  }

  const [transactions, total] = await Promise.all([
    prisma.walletTransaction.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: parseInt(pageSize),
      skip: (parseInt(page) - 1) * parseInt(pageSize),
    }),
    prisma.walletTransaction.count({ where }),
  ]);

  const totalPages = Math.ceil(total / parseInt(pageSize));

  logger.info('Transaction history retrieved', {
    storeId,
    total,
    returned: transactions.length,
  });

  return {
    transactions,
    pagination: {
      page: parseInt(page),
      pageSize: parseInt(pageSize),
      total,
      totalPages,
      hasNextPage: parseInt(page) < totalPages,
      hasPrevPage: parseInt(page) > 1,
    },
  };
}

/**
 * Get billing history (Stripe transactions)
 * @param {string} storeId - Store ID
 * @param {Object} filters - Filter options
 * @returns {Promise<Object>} Billing history
 */
export async function getBillingHistory(storeId, filters = {}) {
  const { page = 1, pageSize = 20, status } = filters;

  logger.info('Getting billing history', { storeId, filters });

  const where = { shopId: storeId };

  if (status && ['pending', 'completed', 'failed'].includes(status)) {
    where.status = status;
  }

  const [transactions, total] = await Promise.all([
    prisma.billingTransaction.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: parseInt(pageSize),
      skip: (parseInt(page) - 1) * parseInt(pageSize),
    }),
    prisma.billingTransaction.count({ where }),
  ]);

  const totalPages = Math.ceil(total / parseInt(pageSize));

  logger.info('Billing history retrieved', {
    storeId,
    total,
    returned: transactions.length,
  });

  // Transform transactions to include frontend-friendly fields
  // Use Promise.all to handle async package lookups
  const transformedTransactions = await Promise.all(
    transactions.map(async transaction => {
      // Get package info from packageType
      let packageName = 'N/A';
      let packageCredits = transaction.creditsAdded;

      try {
        // Try to find package by ID (packageType might be package ID or legacy string)
        const pkg = await prisma.package.findUnique({
          where: { id: transaction.packageType },
        });
        if (pkg) {
          packageName = pkg.name;
          packageCredits = pkg.units;
        } else {
          // Fallback: use packageType as name
          packageName = transaction.packageType || 'N/A';
        }
      } catch (error) {
        // Package not found, use defaults
        packageName = transaction.packageType || 'N/A';
      }

      // Convert amount from cents to currency
      const amountInCurrency = transaction.amount
        ? (transaction.amount / 100).toFixed(2)
        : 0;

      return {
        id: transaction.id,
        packageName,
        credits: transaction.creditsAdded,
        creditsAdded: transaction.creditsAdded, // Keep for backward compatibility
        amount: parseFloat(amountInCurrency), // Amount in currency (not cents)
        amountCents: transaction.amount, // Keep original in cents for reference
        price: parseFloat(amountInCurrency), // Alias for amount
        currency: transaction.currency || 'EUR',
        status: transaction.status,
        packageType: transaction.packageType,
        createdAt: transaction.createdAt,
        updatedAt: transaction.updatedAt,
        // Include package info for backward compatibility
        package: {
          name: packageName,
          credits: packageCredits,
        },
      };
    }),
  );

  return {
    transactions: transformedTransactions,
    pagination: {
      page: parseInt(page),
      pageSize: parseInt(pageSize),
      total,
      totalPages,
      hasNextPage: parseInt(page) < totalPages,
      hasPrevPage: parseInt(page) > 1,
    },
  };
}

export default {
  getBalance,
  getPackages,
  getPackageById,
  createPurchaseSession,
  handleStripeWebhook,
  addCredits,
  deductCredits,
  getTransactionHistory,
  getBillingHistory,
};
