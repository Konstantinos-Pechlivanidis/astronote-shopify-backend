import Stripe from 'stripe';
import prisma from './prisma.js';
import { logger } from '../utils/logger.js';

// Initialize Stripe (only if API key is available)
const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY, {
    apiVersion: '2024-06-20',
  })
  : null;

/**
 * Create Stripe checkout session for credit purchase
 */
export async function createStripeCheckoutSession({
  packageId,
  _packageName, // Renamed to indicate unused
  credits,
  price,
  currency,
  stripePriceId,
  shopId,
  shopDomain,
  metadata = {},
  successUrl,
  cancelUrl,
}) {
  try {
    if (!stripe) {
      logger.error('Stripe is not initialized', {
        hasStripeSecretKey: !!process.env.STRIPE_SECRET_KEY,
        shopId,
        packageId,
      });
      throw new Error(
        'Stripe is not configured. Please set STRIPE_SECRET_KEY environment variable.',
      );
    }

    // Validate required parameters
    if (!stripePriceId) {
      logger.error('Missing stripePriceId', { shopId, packageId, currency });
      throw new Error('Stripe price ID is required');
    }

    if (!shopId) {
      logger.error('Missing shopId', { packageId, currency });
      throw new Error('Shop ID is required');
    }

    if (!shopDomain) {
      logger.error('Missing shopDomain', { shopId, packageId });
      throw new Error('Shop domain is required');
    }

    // Merge provided metadata with required fields
    // Ensure shopId is always present (use from metadata if provided, otherwise from parameter)
    const finalMetadata = {
      shopId: metadata.shopId || metadata.storeId || shopId, // Support both shopId and storeId
      storeId: metadata.storeId || shopId, // Keep storeId for backward compatibility
      packageId: metadata.packageId || packageId,
      credits: metadata.credits || credits.toString(),
      shopDomain: metadata.shopDomain || shopDomain,
      ...metadata, // Spread any additional metadata (e.g., transactionId)
    };

    logger.debug('Creating Stripe checkout session', {
      stripePriceId,
      shopId,
      shopDomain,
      packageId,
      credits,
      price,
      currency,
      successUrl,
      cancelUrl,
    });

    let session;
    try {
      session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: [
          {
            price: stripePriceId,
            quantity: 1,
          },
        ],
        mode: 'payment',
        success_url:
          successUrl ||
          `${process.env.FRONTEND_URL || 'http://localhost:3000'}/settings?success=true&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url:
          cancelUrl ||
          `${process.env.FRONTEND_URL || 'http://localhost:3000'}/settings?canceled=true`,
        metadata: finalMetadata,
        customer_email: `${shopDomain}@astronote.com`, // Use shop domain as email
        billing_address_collection: 'required',
        shipping_address_collection: {
          allowed_countries: [
            'US',
            'CA',
            'GB',
            'DE',
            'FR',
            'IT',
            'ES',
            'NL',
            'BE',
            'AT',
            'CH',
            'SE',
            'NO',
            'DK',
            'FI',
            'GR',
          ],
        },
        payment_intent_data: {
          statement_descriptor: 'ASTRONOTE MARKETING',
        },
      });

      logger.info('Stripe checkout session created', {
        sessionId: session.id,
        shopId,
        packageId,
        credits,
        price,
        currency,
      });
    } catch (stripeError) {
      logger.error('Stripe API error', {
        error: stripeError.message,
        errorType: stripeError.type,
        errorCode: stripeError.code,
        stripeRequestId: stripeError.requestId,
        shopId,
        packageId,
        stripePriceId,
        currency,
      });

      // Provide more helpful error messages
      if (stripeError.type === 'StripeInvalidRequestError') {
        if (stripeError.message.includes('price')) {
          throw new Error(
            `Invalid Stripe price ID: ${stripePriceId}. Please configure the correct STRIPE_PRICE_ID environment variable.`,
          );
        }
        throw new Error(`Stripe configuration error: ${stripeError.message}`);
      }

      throw stripeError;
    }

    return session;
  } catch (error) {
    logger.error('Failed to create Stripe checkout session', {
      error: error.message,
      errorName: error.name,
      shopId,
      packageId,
      stripePriceId,
    });
    throw error;
  }
}

/**
 * Retrieve Stripe checkout session
 */
export async function getCheckoutSession(sessionId) {
  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    return session;
  } catch (error) {
    logger.error('Failed to retrieve Stripe checkout session', {
      error: error.message,
      sessionId,
    });
    throw error;
  }
}

/**
 * Verify Stripe webhook signature
 */
export function verifyWebhookSignature(payload, signature) {
  try {
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!stripe) {
      throw new Error(
        'Stripe is not configured. Please set STRIPE_SECRET_KEY environment variable.',
      );
    }

    if (!webhookSecret) {
      throw new Error('Stripe webhook secret not configured');
    }

    const event = stripe.webhooks.constructEvent(
      payload,
      signature,
      webhookSecret,
    );

    return event;
  } catch (error) {
    logger.error('Failed to verify Stripe webhook signature', {
      error: error.message,
    });
    throw error;
  }
}

/**
 * Handle successful payment
 *
 * NOTE: This function is kept for backward compatibility.
 * For new implementations, use billingService.handleStripeWebhook() which has:
 * - Idempotency checks
 * - Atomic transactions via addCredits()
 * - WalletTransaction record creation
 *
 * @deprecated Prefer using billingService.handleStripeWebhook() for secure processing
 */
export async function handlePaymentSuccess(session) {
  try {
    // Support both shopId and storeId in metadata (they are the same - shop.id)
    const shopId = session.metadata.shopId || session.metadata.storeId;
    const { packageId, credits, transactionId } = session.metadata;

    if (!shopId || !packageId || !credits) {
      throw new Error(
        'Missing required metadata in session. Required: shopId/storeId, packageId, credits',
      );
    }

    const creditsToAdd = parseInt(credits);

    // If transactionId is provided, check for idempotency
    if (transactionId) {
      const transaction = await prisma.billingTransaction.findUnique({
        where: { id: transactionId },
      });

      if (transaction && transaction.status === 'completed') {
        // Get current shop balance
        const shop = await prisma.shop.findUnique({
          where: { id: shopId },
          select: { credits: true },
        });

        logger.warn('Transaction already completed (idempotency check)', {
          transactionId,
          sessionId: session.id,
        });
        return {
          success: true,
          creditsAdded: 0,
          newBalance: shop?.credits || 0,
          alreadyProcessed: true,
        };
      }
    }

    // Use atomic transaction for credit addition
    const result = await prisma.$transaction(async tx => {
      // Update shop credits
      const updatedShop = await tx.shop.update({
        where: { id: shopId },
        data: {
          credits: {
            increment: creditsToAdd,
          },
        },
        select: { credits: true },
      });

      // Update billing transaction status (if transactionId provided)
      if (transactionId) {
        await tx.billingTransaction.update({
          where: { id: transactionId },
          data: {
            status: 'completed',
            stripePaymentId: session.payment_intent,
          },
        });
      } else {
        // Fallback: update by session ID (less precise)
        await tx.billingTransaction.updateMany({
          where: {
            shopId,
            stripeSessionId: session.id,
            status: 'pending',
          },
          data: {
            status: 'completed',
            stripePaymentId: session.payment_intent,
          },
        });
      }

      // Create wallet transaction record for audit trail
      await tx.walletTransaction.create({
        data: {
          shopId,
          type: 'purchase',
          credits: creditsToAdd,
          ref: `stripe:${session.id}`,
          meta: {
            sessionId: session.id,
            paymentIntent: session.payment_intent,
            packageId,
            transactionId: transactionId || null,
          },
        },
      });

      return updatedShop;
    });

    logger.info('Payment processed successfully', {
      shopId,
      packageId,
      creditsAdded: creditsToAdd,
      newBalance: result.credits,
      sessionId: session.id,
    });

    return {
      success: true,
      creditsAdded: creditsToAdd,
      newBalance: result.credits,
    };
  } catch (error) {
    logger.error('Failed to handle payment success', {
      error: error.message,
      sessionId: session.id,
    });
    throw error;
  }
}

/**
 * Handle failed payment
 */
export async function handlePaymentFailure(session) {
  try {
    // Support both shopId and storeId in metadata
    const shopId = session.metadata.shopId || session.metadata.storeId;

    if (!shopId) {
      throw new Error('Missing shopId/storeId in session metadata');
    }

    // Update billing transaction status
    await prisma.billingTransaction.updateMany({
      where: {
        shopId,
        stripeSessionId: session.id,
        status: 'pending',
      },
      data: {
        status: 'failed',
      },
    });

    logger.info('Payment failed', {
      shopId,
      sessionId: session.id,
    });

    return {
      success: true,
      message: 'Payment failure recorded',
    };
  } catch (error) {
    logger.error('Failed to handle payment failure', {
      error: error.message,
      sessionId: session.id,
    });
    throw error;
  }
}

/**
 * Get Stripe customer by email
 */
export async function getCustomerByEmail(email) {
  try {
    const customers = await stripe.customers.list({
      email,
      limit: 1,
    });

    return customers.data[0] || null;
  } catch (error) {
    logger.error('Failed to get Stripe customer', {
      error: error.message,
      email,
    });
    throw error;
  }
}

/**
 * Create Stripe customer
 */
export async function createCustomer({ email, name, shopDomain }) {
  try {
    const customer = await stripe.customers.create({
      email,
      name,
      metadata: {
        shopDomain,
      },
    });

    logger.info('Stripe customer created', {
      customerId: customer.id,
      email,
      shopDomain,
    });

    return customer;
  } catch (error) {
    logger.error('Failed to create Stripe customer', {
      error: error.message,
      email,
      shopDomain,
    });
    throw error;
  }
}

/**
 * Get Stripe subscription price ID from environment variables
 * @param {string} planType - 'starter' or 'pro'
 * @param {string} currency - Currency code (EUR, USD, etc.)
 * @returns {string|null} Stripe price ID or null
 */
export function getStripeSubscriptionPriceId(planType, currency = 'EUR') {
  const upperCurrency = currency.toUpperCase();
  const envKey = `STRIPE_PRICE_ID_SUB_${planType.toUpperCase()}_${upperCurrency}`;
  return process.env[envKey] || null;
}

/**
 * Get Stripe credit top-up price ID from environment variables
 * @param {string} currency - Currency code (EUR, USD, etc.)
 * @returns {string|null} Stripe price ID or null
 */
export function getStripeCreditTopupPriceId(currency = 'EUR') {
  const upperCurrency = currency.toUpperCase();
  const envKey = `STRIPE_PRICE_ID_CREDIT_TOPUP_${upperCurrency}`;
  return process.env[envKey] || null;
}

/**
 * Get Stripe price ID for a package and currency
 * @param {string} packageName - Package name or identifier
 * @param {string} currency - Currency code (EUR, USD, etc.)
 * @param {Object|null} packageDb - Package database record (optional)
 * @returns {string|null} Stripe price ID or null
 */
export function getStripePriceId(
  packageName,
  currency = 'EUR',
  packageDb = null,
) {
  const upperCurrency = currency.toUpperCase();

  // First priority: Check package DB fields if provided
  if (packageDb) {
    if (upperCurrency === 'USD' && packageDb.stripePriceIdUsd) {
      return packageDb.stripePriceIdUsd;
    }
    if (upperCurrency === 'EUR' && packageDb.stripePriceIdEur) {
      return packageDb.stripePriceIdEur;
    }
  }

  // Second priority: Environment variable
  const envKey = `STRIPE_PRICE_ID_${packageName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_${upperCurrency}`;
  const envPriceId = process.env[envKey];
  if (envPriceId) return envPriceId;

  // Fallback: Generic format
  const genericKey = `STRIPE_PRICE_ID_${upperCurrency}`;
  return process.env[genericKey] || null;
}

/**
 * Create a Stripe checkout session for subscription
 * @param {Object} params
 * @param {string} params.shopId - Shop ID
 * @param {string} params.shopDomain - Shop domain
 * @param {string} params.planType - 'starter' or 'pro'
 * @param {string} params.currency - Currency code (EUR, USD, etc.)
 * @param {string} params.successUrl - Success redirect URL
 * @param {string} params.cancelUrl - Cancel redirect URL
 * @returns {Promise<Object>} Stripe checkout session
 */
export async function createSubscriptionCheckoutSession({
  shopId,
  shopDomain,
  planType,
  currency = 'EUR',
  successUrl,
  cancelUrl,
}) {
  if (!stripe) {
    throw new Error('Stripe is not configured');
  }

  if (!['starter', 'pro'].includes(planType)) {
    throw new Error(`Invalid plan type: ${planType}`);
  }

  const priceId = getStripeSubscriptionPriceId(planType, currency);
  if (!priceId) {
    throw new Error(
      `Stripe price ID not found for subscription plan ${planType} (${currency}). Please configure STRIPE_PRICE_ID_SUB_${planType.toUpperCase()}_${currency.toUpperCase()} in your environment variables.`,
    );
  }

  // Verify the price exists and is a recurring price
  try {
    const price = await stripe.prices.retrieve(priceId);
    if (price.type !== 'recurring') {
      throw new Error(
        `Price ID ${priceId} is not a recurring price. Subscription plans require recurring prices.`,
      );
    }
    if (!price.recurring) {
      throw new Error(
        `Price ID ${priceId} does not have recurring configuration.`,
      );
    }
  } catch (err) {
    if (
      err.type === 'StripeInvalidRequestError' &&
      err.code === 'resource_missing'
    ) {
      throw new Error(
        `Price ID ${priceId} not found in Stripe. Please verify the price ID is correct.`,
      );
    }
    // Re-throw if it's our custom error
    if (
      err.message?.includes('not a recurring price') ||
      err.message?.includes('does not have recurring')
    ) {
      throw err;
    }
    // For other errors, log but continue (price might still be valid)
    logger.warn(
      { priceId, err: err.message },
      'Could not verify price type, continuing anyway',
    );
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        shopId: String(shopId),
        storeId: String(shopId), // Keep for backward compatibility
        planType,
        type: 'subscription',
      },
      customer_email: `${shopDomain}@astronote.com`,
      client_reference_id: `shop_${shopId}`,
      subscription_data: {
        metadata: {
          shopId: String(shopId),
          storeId: String(shopId), // Keep for backward compatibility
          planType,
        },
      },
      expand: ['line_items', 'subscription'],
    });

    logger.info('Subscription checkout session created', {
      sessionId: session.id,
      shopId,
      planType,
      currency,
    });

    return session;
  } catch (err) {
    // Handle Stripe-specific errors
    if (err.type === 'StripeInvalidRequestError') {
      if (err.message?.includes('recurring price')) {
        throw new Error(
          `The price ID ${priceId} is not configured as a recurring price in Stripe. Please create a recurring price for the ${planType} plan.`,
        );
      }
      throw new Error(`Stripe error: ${err.message}`);
    }
    throw err;
  }
}

/**
 * Create a Stripe checkout session for credit top-up
 * @param {Object} params
 * @param {string} params.shopId - Shop ID
 * @param {string} params.shopDomain - Shop domain
 * @param {number} params.credits - Number of credits to purchase
 * @param {number} params.priceEur - Price in EUR (including VAT)
 * @param {string} params.currency - Currency code (EUR, USD, etc.)
 * @param {string} params.successUrl - Success redirect URL
 * @param {string} params.cancelUrl - Cancel redirect URL
 * @returns {Promise<Object>} Stripe checkout session
 */
export async function createCreditTopupCheckoutSession({
  shopId,
  shopDomain,
  credits,
  priceEur,
  currency = 'EUR',
  successUrl,
  cancelUrl,
}) {
  if (!stripe) {
    throw new Error('Stripe is not configured');
  }

  // Try to use configured price ID first
  const priceId = getStripeCreditTopupPriceId(currency);

  // If no price ID configured, create a one-time payment with custom amount
  if (!priceId) {
    // Create checkout session with custom amount
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: currency.toLowerCase(),
            product_data: {
              name: `${credits} SMS Credits`,
              description: `Top-up of ${credits} SMS credits`,
            },
            unit_amount: Math.round(priceEur * 100), // Convert EUR to cents (ensure integer)
          },
          quantity: 1,
        },
      ],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        shopId: String(shopId),
        storeId: String(shopId), // Keep for backward compatibility
        credits: String(credits),
        priceEur: String(priceEur),
        type: 'credit_topup',
      },
      customer_email: `${shopDomain}@astronote.com`,
      client_reference_id: `shop_${shopId}_topup_${credits}`,
      expand: ['line_items'],
    });

    logger.info('Credit top-up checkout session created', {
      sessionId: session.id,
      shopId,
      credits,
      priceEur,
      currency,
    });

    return session;
  }

  // Use configured price ID
  // IMPORTANT: The price ID must be configured as a per-credit price (unit_amount per credit)
  // If using a fixed-amount price, use custom price_data instead (handled above)
  // Validate price type before using
  let price = null;
  let validatedPriceId = priceId;
  try {
    price = await stripe.prices.retrieve(validatedPriceId);
    if (price.type !== 'one_time') {
      logger.warn(
        { priceId: validatedPriceId, priceType: price.type },
        'Credit top-up price ID is not a one-time price, falling back to custom price_data',
      );
      // Fall back to custom price_data
      validatedPriceId = null;
    }
  } catch (err) {
    logger.warn(
      { priceId: validatedPriceId, err: err.message },
      'Failed to retrieve price, falling back to custom price_data',
    );
    validatedPriceId = null;
  }

  // If price validation failed or price ID is invalid, use custom price_data
  if (!validatedPriceId || !price) {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: currency.toLowerCase(),
            product_data: {
              name: `${credits} SMS Credits`,
              description: `Top-up of ${credits} SMS credits`,
            },
            unit_amount: Math.round(priceEur * 100), // Convert EUR to cents (ensure integer)
          },
          quantity: 1,
        },
      ],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        shopId: String(shopId),
        storeId: String(shopId), // Keep for backward compatibility
        credits: String(credits),
        priceEur: String(priceEur),
        type: 'credit_topup',
      },
      customer_email: `${shopDomain}@astronote.com`,
      client_reference_id: `shop_${shopId}_topup_${credits}`,
      expand: ['line_items'],
    });
    return session;
  }

  // Use validated price ID (assumed to be per-credit)
  // NOTE: This assumes the price ID is configured with unit_amount = price per credit in cents
  // If your price ID is for a fixed amount, do not use this path - use custom price_data instead
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    line_items: [
      {
        price: validatedPriceId,
        quantity: credits, // Price is per-credit, so quantity = number of credits
      },
    ],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: {
      shopId: String(shopId),
      storeId: String(shopId), // Keep for backward compatibility
      credits: String(credits),
      priceEur: String(priceEur),
      type: 'credit_topup',
    },
    customer_email: `${shopDomain}@astronote.com`,
    client_reference_id: `shop_${shopId}_topup_${credits}`,
    expand: ['line_items'],
  });

  logger.info('Credit top-up checkout session created', {
    sessionId: session.id,
    shopId,
    credits,
    priceEur,
    currency,
  });

  return session;
}

/**
 * Update subscription to a new plan
 * @param {string} subscriptionId - Stripe subscription ID
 * @param {string} newPlanType - 'starter' or 'pro'
 * @returns {Promise<Object>} Updated subscription
 */
export async function updateSubscription(subscriptionId, newPlanType) {
  if (!stripe) {
    throw new Error('Stripe is not configured');
  }

  if (!['starter', 'pro'].includes(newPlanType)) {
    throw new Error(`Invalid plan type: ${newPlanType}`);
  }

  // Get subscription price ID for the new plan
  const newPriceId = getStripeSubscriptionPriceId(newPlanType, 'EUR');
  if (!newPriceId) {
    throw new Error(`Stripe price ID not found for ${newPlanType} plan`);
  }

  // Retrieve current subscription
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);

  // Update subscription with new price
  const updated = await stripe.subscriptions.update(subscriptionId, {
    items: [
      {
        id: subscription.items.data[0].id,
        price: newPriceId,
      },
    ],
    proration_behavior: 'always_invoice', // Prorate the change
    metadata: {
      planType: newPlanType,
      updatedAt: new Date().toISOString(),
    },
  });

  logger.info(
    { subscriptionId, newPlanType, newPriceId },
    'Subscription updated',
  );
  return updated;
}

/**
 * Cancel subscription
 * @param {string} subscriptionId - Stripe subscription ID
 * @returns {Promise<Object>} Cancelled subscription
 */
export async function cancelSubscription(subscriptionId) {
  if (!stripe) {
    throw new Error('Stripe is not configured');
  }

  return stripe.subscriptions.cancel(subscriptionId);
}

/**
 * Get Stripe customer portal URL
 * @param {string} customerId - Stripe customer ID
 * @param {string} returnUrl - URL to return to after portal session
 * @returns {Promise<string>} Portal URL
 */
export async function getCustomerPortalUrl(customerId, returnUrl) {
  if (!stripe) {
    throw new Error('Stripe is not configured');
  }

  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  });

  return session.url;
}

export default {
  createStripeCheckoutSession,
  getCheckoutSession,
  verifyWebhookSignature,
  handlePaymentSuccess,
  handlePaymentFailure,
  getCustomerByEmail,
  createCustomer,
  getStripeSubscriptionPriceId,
  getStripeCreditTopupPriceId,
  getStripePriceId,
  createSubscriptionCheckoutSession,
  createCreditTopupCheckoutSession,
  updateSubscription,
  cancelSubscription,
  getCustomerPortalUrl,
};
