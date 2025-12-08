import { logger } from '../utils/logger.js';
import {
  verifyWebhookSignature,
  handlePaymentFailure,
} from '../services/stripe.js';
import billingService from '../services/billing.js';
import { credit } from '../services/wallet.js';
import {
  activateSubscription,
  allocateFreeCredits,
  deactivateSubscription,
} from '../services/subscription.js';
import prisma from '../services/prisma.js';
import Stripe from 'stripe';
import { sendSuccess } from '../utils/response.js';
import { ValidationError } from '../utils/errors.js';

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY, {
    apiVersion: '2024-06-20',
  })
  : null;

/**
 * Handle Stripe webhook events
 */
export async function handleStripeWebhook(req, res) {
  try {
    const signature = req.headers['stripe-signature'];
    const payload = req.rawBody || JSON.stringify(req.body);

    if (!signature) {
      throw new ValidationError('Stripe signature header is required');
    }

    // Verify webhook signature
    const event = verifyWebhookSignature(payload, signature);

    logger.info('Stripe webhook received', {
      eventType: event.type,
      eventId: event.id,
    });

    // Handle different event types
    switch (event.type) {
    case 'checkout.session.completed':
      await handleCheckoutSessionCompleted(event.data.object);
      break;

    case 'checkout.session.expired':
      await handleCheckoutSessionExpired(event.data.object);
      break;

    case 'payment_intent.succeeded':
      await handlePaymentIntentSucceeded(event.data.object);
      break;

    case 'payment_intent.payment_failed':
      await handlePaymentIntentFailed(event.data.object);
      break;

    case 'invoice.payment_succeeded':
      await handleInvoicePaymentSucceeded(event.data.object);
      break;

    case 'invoice.payment_failed':
      await handleInvoicePaymentFailed(event.data.object);
      break;

    case 'customer.subscription.updated':
      await handleSubscriptionUpdated(event.data.object);
      break;

    case 'customer.subscription.deleted':
      await handleSubscriptionDeleted(event.data.object);
      break;

    case 'charge.refunded':
    case 'payment_intent.refunded':
      await handleRefund(event);
      break;

    default:
      logger.info('Unhandled Stripe event type', {
        eventType: event.type,
        eventId: event.id,
      });
    }

    return sendSuccess(res, { message: 'Webhook processed successfully' });
  } catch (error) {
    logger.error('Stripe webhook processing failed', {
      error: error.message,
      headers: req.headers,
    });
    throw error; // Let global error handler process it
  }
}

/**
 * Handle checkout session completed
 * Routes to appropriate handler based on payment type (subscription, top-up, or pack)
 */
async function handleCheckoutSessionCompleted(session) {
  try {
    logger.info('Checkout session completed', {
      sessionId: session.id,
      paymentStatus: session.payment_status,
      metadata: session.metadata,
      mode: session.mode,
    });

    if (session.payment_status !== 'paid') {
      logger.warn('Checkout session completed but not paid', {
        sessionId: session.id,
        paymentStatus: session.payment_status,
      });
      return;
    }

    const metadata = session.metadata || {};
    const type = metadata.type;

    // Route based on payment type
    if (type === 'subscription' || session.mode === 'subscription') {
      await handleCheckoutSessionCompletedForSubscription(session);
    } else if (type === 'credit_topup') {
      await handleCheckoutSessionCompletedForTopup(session);
    } else {
      // Legacy: Handle package purchase (credit packs)
      const event = {
        type: 'checkout.session.completed',
        data: { object: session },
        id: `evt_${session.id}`,
      };
      await billingService.handleStripeWebhook(event);
    }
  } catch (error) {
    logger.error('Failed to handle checkout session completed', {
      error: error.message,
      sessionId: session.id,
    });
    throw error;
  }
}

/**
 * Handle checkout.session.completed for subscription
 */
async function handleCheckoutSessionCompletedForSubscription(session) {
  const metadata = session.metadata || {};
  const shopId = metadata.shopId || metadata.storeId;
  const planType = metadata.planType;

  if (!shopId || !planType) {
    logger.warn(
      { sessionId: session.id },
      'Subscription checkout missing required metadata',
    );
    return;
  }

  if (!['starter', 'pro'].includes(planType)) {
    logger.warn(
      { sessionId: session.id, planType },
      'Invalid plan type in subscription checkout',
    );
    return;
  }

  const subscriptionId =
    typeof session.subscription === 'string'
      ? session.subscription
      : session.subscription?.id;
  const customerId =
    typeof session.customer === 'string'
      ? session.customer
      : session.customer?.id;

  if (!subscriptionId || !customerId) {
    logger.warn(
      { sessionId: session.id },
      'Subscription checkout missing subscription or customer ID',
    );
    return;
  }

  logger.info(
    { shopId, planType, subscriptionId, sessionId: session.id },
    'Processing subscription checkout completion',
  );

  try {
    // Retrieve subscription from Stripe
    let stripeSubscription = null;
    try {
      stripeSubscription = await stripe.subscriptions.retrieve(subscriptionId);
    } catch (err) {
      logger.warn(
        { subscriptionId, err: err.message },
        'Failed to retrieve subscription from Stripe',
      );
    }

    // Activate subscription (sets planType and subscriptionStatus)
    logger.info(
      { shopId, planType, subscriptionId },
      'Activating subscription',
    );
    await activateSubscription(shopId, customerId, subscriptionId, planType);
    logger.info(
      { shopId, planType, subscriptionId },
      'Subscription activated successfully',
    );

    // Allocate free credits (idempotent)
    // Pass planType explicitly to avoid race condition with database read
    logger.info(
      { shopId, planType, subscriptionId },
      'Allocating free credits for subscription',
    );
    const result = await allocateFreeCredits(
      shopId,
      planType,
      `sub_${subscriptionId}`,
      stripeSubscription,
    );

    if (result.allocated) {
      logger.info(
        {
          shopId,
          planType,
          subscriptionId,
          credits: result.credits,
        },
        'Free credits allocated successfully',
      );
    } else {
      logger.info(
        {
          shopId,
          planType,
          subscriptionId,
          reason: result.reason,
          credits: result.credits || 0,
        },
        'Free credits not allocated (already allocated or other reason)',
      );
    }
  } catch (err) {
    logger.error(
      {
        shopId,
        planType,
        subscriptionId,
        err: err.message,
        stack: err.stack,
      },
      'Failed to process subscription checkout',
    );
    throw err;
  }
}

/**
 * Handle checkout.session.completed for credit top-up
 */
async function handleCheckoutSessionCompletedForTopup(session) {
  const metadata = session.metadata || {};
  const shopId = metadata.shopId || metadata.storeId;
  const credits = Number(metadata.credits);
  const priceEur = Number(metadata.priceEur);

  if (!shopId || !credits || !priceEur) {
    logger.warn(
      { sessionId: session.id },
      'Credit top-up checkout missing required metadata',
    );
    return;
  }

  logger.info(
    { shopId, credits, priceEur, sessionId: session.id },
    'Processing credit top-up checkout completion',
  );

  // Validate payment amount matches expected amount (fraud prevention)
  const expectedAmountCents = Math.round(priceEur * 100);
  const actualAmountCents = session.amount_total || 0;

  // Allow small rounding differences (up to 1 cent)
  if (Math.abs(actualAmountCents - expectedAmountCents) > 1) {
    logger.error(
      {
        shopId,
        sessionId: session.id,
        expectedAmountCents,
        actualAmountCents,
        credits,
        priceEur,
      },
      'Payment amount mismatch - potential fraud or configuration error',
    );
    throw new Error(
      `Payment amount mismatch: expected ${expectedAmountCents} cents, got ${actualAmountCents} cents`,
    );
  }

  // Check if already processed (idempotency)
  const existingTxn = await prisma.creditTransaction.findFirst({
    where: {
      shopId,
      reason: 'stripe:topup',
      meta: {
        path: ['sessionId'],
        equals: session.id,
      },
    },
  });

  if (existingTxn) {
    logger.info(
      {
        shopId,
        sessionId: session.id,
        transactionId: existingTxn.id,
        credits,
      },
      'Credit top-up already processed (idempotency check)',
    );
    return;
  }

  try {
    logger.debug({ shopId, credits, priceEur }, 'Adding credits to wallet');
    await prisma.$transaction(async tx => {
      // Credit wallet
      await credit(
        shopId,
        credits,
        {
          reason: 'stripe:topup',
          meta: {
            sessionId: session.id,
            paymentIntentId: session.payment_intent || null,
            customerId: session.customer || null,
            credits,
            priceEur,
            purchasedAt: new Date().toISOString(),
          },
        },
        tx,
      );
    });

    logger.info(
      {
        shopId,
        credits,
        priceEur,
        sessionId: session.id,
        paymentIntentId: session.payment_intent,
      },
      'Credit top-up processed successfully',
    );
  } catch (err) {
    logger.error(
      { shopId, credits, err: err.message, stack: err.stack },
      'Failed to process credit top-up',
    );
    throw err;
  }
}

/**
 * Handle checkout session expired
 */
async function handleCheckoutSessionExpired(session) {
  try {
    logger.info('Checkout session expired', {
      sessionId: session.id,
      metadata: session.metadata,
    });

    await handlePaymentFailure(session);
  } catch (error) {
    logger.error('Failed to handle checkout session expired', {
      error: error.message,
      sessionId: session.id,
    });
    throw error;
  }
}

/**
 * Handle payment intent succeeded
 */
async function handlePaymentIntentSucceeded(paymentIntent) {
  try {
    logger.info('Payment intent succeeded', {
      paymentIntentId: paymentIntent.id,
      amount: paymentIntent.amount,
      currency: paymentIntent.currency,
    });

    // Additional processing if needed
    // The main logic is handled in checkout.session.completed
  } catch (error) {
    logger.error('Failed to handle payment intent succeeded', {
      error: error.message,
      paymentIntentId: paymentIntent.id,
    });
    throw error;
  }
}

/**
 * Handle payment intent failed
 * Updates pending transactions to failed status
 */
async function handlePaymentIntentFailed(paymentIntent) {
  try {
    logger.info('Payment intent failed', {
      paymentIntentId: paymentIntent.id,
      amount: paymentIntent.amount,
      currency: paymentIntent.currency,
      failureCode: paymentIntent.last_payment_error?.code,
      failureMessage: paymentIntent.last_payment_error?.message,
    });

    // Update any pending transactions with this payment intent
    const prisma = (await import('../services/prisma.js')).default;

    const updated = await prisma.billingTransaction.updateMany({
      where: {
        stripePaymentId: paymentIntent.id,
        status: 'pending',
      },
      data: {
        status: 'failed',
      },
    });

    logger.info('Updated failed transactions', {
      paymentIntentId: paymentIntent.id,
      updatedCount: updated.count,
    });
  } catch (error) {
    logger.error('Failed to handle payment intent failed', {
      error: error.message,
      paymentIntentId: paymentIntent.id,
    });
    throw error;
  }
}

/**
 * Handle invoice.payment_succeeded event
 * This is fired for subscription renewals
 */
async function handleInvoicePaymentSucceeded(invoice) {
  logger.info(
    { invoiceId: invoice.id, billingReason: invoice.billing_reason },
    'Processing invoice payment succeeded',
  );

  // Skip subscription_create invoices - they are handled by checkout.session.completed
  // This prevents race conditions where invoice.payment_succeeded fires before checkout.session.completed
  if (invoice.billing_reason === 'subscription_create') {
    logger.debug(
      { invoiceId: invoice.id, billingReason: invoice.billing_reason },
      'Skipping subscription_create invoice (handled by checkout.session.completed)',
    );
    return;
  }

  // Only process subscription_cycle invoices (recurring billing)
  if (invoice.billing_reason !== 'subscription_cycle') {
    logger.debug(
      { invoiceId: invoice.id, billingReason: invoice.billing_reason },
      'Skipping non-subscription-cycle invoice',
    );
    return;
  }

  const subscriptionId = invoice.subscription;
  const customerId = invoice.customer;

  if (!subscriptionId || !customerId) {
    logger.warn(
      { invoiceId: invoice.id },
      'Invoice missing subscription or customer ID',
    );
    return;
  }

  logger.debug(
    { invoiceId: invoice.id, subscriptionId, customerId },
    'Looking up shop for invoice',
  );

  // Find shop by Stripe customer ID
  const shop = await prisma.shop.findFirst({
    where: {
      stripeCustomerId: customerId,
    },
    select: {
      id: true,
      planType: true,
      subscriptionStatus: true,
      stripeSubscriptionId: true,
    },
  });

  if (!shop) {
    logger.warn(
      { customerId, invoiceId: invoice.id },
      'Shop not found for invoice',
    );
    return;
  }

  // Verify subscription ID matches
  if (shop.stripeSubscriptionId !== subscriptionId) {
    logger.warn(
      {
        shopId: shop.id,
        shopSubscriptionId: shop.stripeSubscriptionId,
        invoiceSubscriptionId: subscriptionId,
      },
      'Subscription ID mismatch between shop and invoice',
    );
    return;
  }

  if (shop.subscriptionStatus !== 'active') {
    logger.warn(
      {
        shopId: shop.id,
        subscriptionStatus: shop.subscriptionStatus,
        invoiceId: invoice.id,
      },
      'Shop subscription not active - skipping credit allocation',
    );
    return;
  }

  // Get subscription details from Stripe
  let stripeSubscription = null;
  try {
    stripeSubscription = await stripe.subscriptions.retrieve(subscriptionId);
    logger.debug(
      {
        subscriptionId,
        billingPeriodStart: stripeSubscription.current_period_start,
        billingPeriodEnd: stripeSubscription.current_period_end,
      },
      'Retrieved subscription details from Stripe',
    );
  } catch (err) {
    logger.warn(
      { subscriptionId, err: err.message },
      'Failed to retrieve subscription from Stripe',
    );
  }

  // Allocate free credits for this billing cycle (idempotent)
  logger.info(
    {
      shopId: shop.id,
      planType: shop.planType,
      invoiceId: invoice.id,
      subscriptionId,
    },
    'Allocating free credits for billing cycle',
  );

  try {
    const result = await allocateFreeCredits(
      shop.id,
      shop.planType,
      invoice.id,
      stripeSubscription,
    );
    if (result.allocated) {
      logger.info(
        {
          shopId: shop.id,
          planType: shop.planType,
          invoiceId: invoice.id,
          credits: result.credits,
          subscriptionId,
        },
        'Free credits allocated successfully for billing cycle',
      );
    } else {
      logger.info(
        {
          shopId: shop.id,
          invoiceId: invoice.id,
          reason: result.reason,
          credits: result.credits || 0,
        },
        'Free credits not allocated (already allocated or other reason)',
      );
    }
  } catch (err) {
    logger.error(
      {
        shopId: shop.id,
        invoiceId: invoice.id,
        subscriptionId,
        err: err.message,
        stack: err.stack,
      },
      'Failed to allocate free credits for billing cycle',
    );
    throw err;
  }
}

/**
 * Handle invoice.payment_failed event
 */
async function handleInvoicePaymentFailed(invoice) {
  logger.info(
    { invoiceId: invoice.id, billingReason: invoice.billing_reason },
    'Processing invoice payment failed',
  );

  const subscriptionId = invoice.subscription;
  const customerId = invoice.customer;

  if (!subscriptionId || !customerId) {
    logger.warn(
      { invoiceId: invoice.id },
      'Invoice missing subscription or customer ID',
    );
    return;
  }

  // Find shop by Stripe customer ID
  const shop = await prisma.shop.findFirst({
    where: {
      stripeCustomerId: customerId,
    },
    select: {
      id: true,
      subscriptionStatus: true,
    },
  });

  if (!shop) {
    logger.warn(
      { customerId, invoiceId: invoice.id },
      'Shop not found for invoice',
    );
    return;
  }

  // Log payment failure (don't deactivate subscription immediately - Stripe will retry)
  logger.warn(
    {
      shopId: shop.id,
      invoiceId: invoice.id,
      subscriptionId,
    },
    'Invoice payment failed - subscription may be past_due',
  );
}

/**
 * Handle customer.subscription.updated event
 */
async function handleSubscriptionUpdated(subscription) {
  logger.info(
    { subscriptionId: subscription.id, status: subscription.status },
    'Processing subscription updated',
  );

  const subscriptionId = subscription.id;
  const customerId = subscription.customer;

  if (!subscriptionId || !customerId) {
    logger.warn({ subscriptionId }, 'Subscription missing customer ID');
    return;
  }

  // Find shop by Stripe customer ID
  const shop = await prisma.shop.findFirst({
    where: {
      stripeCustomerId: customerId,
    },
    select: {
      id: true,
      planType: true,
      subscriptionStatus: true,
      stripeSubscriptionId: true,
    },
  });

  if (!shop) {
    logger.warn(
      { customerId, subscriptionId },
      'Shop not found for subscription',
    );
    return;
  }

  // Verify subscription ID matches
  if (shop.stripeSubscriptionId !== subscriptionId) {
    logger.warn(
      {
        shopId: shop.id,
        shopSubscriptionId: shop.stripeSubscriptionId,
        eventSubscriptionId: subscriptionId,
      },
      'Subscription ID mismatch',
    );
    return;
  }

  // Determine new status
  let newStatus = shop.subscriptionStatus;
  if (subscription.status === 'active') {
    newStatus = 'active';
  } else if (
    subscription.status === 'past_due' ||
    subscription.status === 'unpaid'
  ) {
    // Keep as active for now - Stripe will retry
    logger.warn(
      {
        shopId: shop.id,
        subscriptionStatus: subscription.status,
      },
      'Subscription is past_due or unpaid - keeping active status',
    );
  } else if (
    subscription.status === 'canceled' ||
    subscription.status === 'incomplete_expired'
  ) {
    newStatus = 'cancelled';
  } else if (
    subscription.status === 'incomplete' ||
    subscription.status === 'trialing'
  ) {
    // Keep current status
  }

  // Extract planType from subscription metadata or price ID
  let newPlanType = shop.planType;
  const subscriptionMetadata = subscription.metadata || {};
  const metadataPlanType = subscriptionMetadata.planType;

  // Try to get planType from metadata first
  if (metadataPlanType && ['starter', 'pro'].includes(metadataPlanType)) {
    newPlanType = metadataPlanType;
  } else {
    // Fallback: determine planType from price ID
    const priceId = subscription.items?.data?.[0]?.price?.id;
    if (priceId) {
      const starterPriceId = process.env.STRIPE_PRICE_ID_SUB_STARTER_EUR;
      const proPriceId = process.env.STRIPE_PRICE_ID_SUB_PRO_EUR;
      if (priceId === starterPriceId) {
        newPlanType = 'starter';
      } else if (priceId === proPriceId) {
        newPlanType = 'pro';
      }
    }
  }

  const statusChanged = shop.subscriptionStatus !== newStatus;
  const planTypeChanged = newPlanType && shop.planType !== newPlanType;

  if (statusChanged || planTypeChanged) {
    logger.info(
      {
        shopId: shop.id,
        oldStatus: shop.subscriptionStatus,
        newStatus,
        oldPlanType: shop.planType,
        newPlanType,
      },
      'Updating subscription status and/or planType',
    );

    await prisma.shop.update({
      where: { id: shop.id },
      data: {
        ...(statusChanged && { subscriptionStatus: newStatus }),
        ...(planTypeChanged && { planType: newPlanType }),
      },
    });

    logger.info(
      {
        shopId: shop.id,
        oldStatus: shop.subscriptionStatus,
        newStatus,
        oldPlanType: shop.planType,
        newPlanType,
      },
      'Subscription status and/or planType updated',
    );
  } else {
    logger.debug(
      {
        shopId: shop.id,
        status: shop.subscriptionStatus,
        planType: shop.planType,
      },
      'Subscription status and planType unchanged',
    );
  }
}

/**
 * Handle customer.subscription.deleted event
 */
async function handleSubscriptionDeleted(subscription) {
  logger.info(
    { subscriptionId: subscription.id },
    'Processing subscription deleted',
  );

  const subscriptionId = subscription.id;
  const customerId = subscription.customer;

  if (!subscriptionId || !customerId) {
    logger.warn({ subscriptionId }, 'Subscription missing customer ID');
    return;
  }

  // Find shop by Stripe customer ID
  const shop = await prisma.shop.findFirst({
    where: {
      stripeCustomerId: customerId,
    },
    select: {
      id: true,
      subscriptionStatus: true,
      stripeSubscriptionId: true,
    },
  });

  if (!shop) {
    logger.warn(
      { customerId, subscriptionId },
      'Shop not found for subscription',
    );
    return;
  }

  // Verify subscription ID matches
  if (shop.stripeSubscriptionId !== subscriptionId) {
    logger.warn(
      {
        shopId: shop.id,
        shopSubscriptionId: shop.stripeSubscriptionId,
        eventSubscriptionId: subscriptionId,
      },
      'Subscription ID mismatch',
    );
    return;
  }

  // Deactivate subscription
  await deactivateSubscription(shop.id, 'cancelled');

  logger.info(
    {
      shopId: shop.id,
      subscriptionId,
    },
    'Subscription deactivated',
  );
}

/**
 * Handle refund events
 * Processes refunds and deducts credits
 */
async function handleRefund(event) {
  try {
    logger.info('Refund event received', {
      eventType: event.type,
      eventId: event.id,
    });

    const charge = event.data.object;
    const chargeId = charge.id;
    const paymentIntentId = charge.payment_intent;

    if (!paymentIntentId) {
      logger.warn({ chargeId }, 'Refund missing payment intent ID');
      return;
    }

    // Find original credit transaction
    const originalTxn = await prisma.creditTransaction.findFirst({
      where: {
        type: 'credit',
        meta: {
          path: ['paymentIntentId'],
          equals: paymentIntentId,
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    if (!originalTxn) {
      logger.warn(
        { paymentIntentId, chargeId },
        'Original credit transaction not found for refund',
      );
      // Use billing service as fallback for legacy transactions
      await billingService.handleStripeWebhook(event);
      return;
    }

    // Check if refund already processed (idempotency)
    const existingRefund = await prisma.creditTransaction.findFirst({
      where: {
        shopId: originalTxn.shopId,
        type: 'refund',
        reason: 'stripe:refund',
        meta: {
          path: ['chargeId'],
          equals: chargeId,
        },
      },
    });

    if (existingRefund) {
      logger.info(
        { shopId: originalTxn.shopId, chargeId },
        'Refund already processed (idempotency check)',
      );
      return;
    }

    // Determine credits to deduct
    let creditsToDeduct = originalTxn.amount;
    if (originalTxn.reason === 'stripe:topup' && originalTxn.meta?.credits) {
      creditsToDeduct = originalTxn.meta.credits;
    }

    // Deduct credits (atomic transaction)
    const { refund } = await import('../services/wallet.js');
    await refund(originalTxn.shopId, creditsToDeduct, {
      reason: 'stripe:refund',
      meta: {
        chargeId,
        paymentIntentId,
        originalTransactionId: originalTxn.id,
        originalReason: originalTxn.reason,
        refundedAt: new Date().toISOString(),
      },
    });

    // Update Purchase status if exists
    const purchase = await prisma.purchase.findFirst({
      where: {
        shopId: originalTxn.shopId,
        stripePaymentIntentId: paymentIntentId,
        status: 'paid',
      },
    });

    if (purchase) {
      await prisma.purchase.update({
        where: { id: purchase.id },
        data: { status: 'refunded' },
      });
      logger.info(
        {
          shopId: originalTxn.shopId,
          purchaseId: purchase.id,
        },
        'Purchase status updated to refunded',
      );
    }

    logger.info(
      {
        shopId: originalTxn.shopId,
        chargeId,
        creditsDeducted: creditsToDeduct,
      },
      'Refund processed successfully',
    );
  } catch (error) {
    logger.error('Failed to handle refund', {
      error: error.message,
      eventType: event.type,
      eventId: event.id,
    });
    // Don't throw - log and continue (refund might be for different system)
    logger.warn('Refund processing failed, but continuing', {
      error: error.message,
    });
  }
}

export default {
  handleStripeWebhook,
};
