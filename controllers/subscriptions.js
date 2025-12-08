import { logger } from '../utils/logger.js';
import { sendSuccess, sendError } from '../utils/response.js';
import { getStoreId } from '../middlewares/store-resolution.js';
import {
  getSubscriptionStatus,
  activateSubscription,
  deactivateSubscription,
  allocateFreeCredits,
} from '../services/subscription.js';
import {
  createSubscriptionCheckoutSession,
  updateSubscription,
  cancelSubscription,
  getCheckoutSession,
} from '../services/stripe.js';
import Stripe from 'stripe';

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY, {
    apiVersion: '2024-06-20',
  })
  : null;

/**
 * GET /api/subscriptions/status
 * Get current subscription status
 */
export async function getStatus(req, res, next) {
  try {
    const shopId = getStoreId(req);

    const subscription = await getSubscriptionStatus(shopId);

    return sendSuccess(res, subscription, 'Subscription status retrieved');
  } catch (error) {
    logger.error('Get subscription status error', {
      error: error.message,
      shopId: getStoreId(req),
    });
    next(error);
  }
}

/**
 * POST /api/subscriptions/subscribe
 * Create subscription checkout session
 * Body: { planType: 'starter' | 'pro' }
 */
export async function subscribe(req, res, next) {
  try {
    const shopId = getStoreId(req);
    const shopDomain = req.ctx?.store?.shopDomain;
    const { planType } = req.body;

    // Check if shop already has an active subscription
    const currentSubscription = await getSubscriptionStatus(shopId);
    if (currentSubscription.active) {
      logger.info(
        {
          shopId,
          currentPlanType: currentSubscription.planType,
          requestedPlanType: planType,
        },
        'Shop attempted to subscribe while already having active subscription',
      );
      return sendError(
        res,
        400,
        'ALREADY_SUBSCRIBED',
        'You already have an active subscription. Please cancel your current subscription before subscribing to a new plan.',
        {
          currentPlan: currentSubscription.planType,
        },
      );
    }

    const baseUrl =
      process.env.FRONTEND_URL ||
      process.env.WEB_APP_URL ||
      'http://localhost:3000';
    const successUrl = `${baseUrl}/shopify/app/billing/success?session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${baseUrl}/shopify/app/billing/cancel`;

    const session = await createSubscriptionCheckoutSession({
      shopId,
      shopDomain,
      planType,
      currency: 'EUR',
      successUrl,
      cancelUrl,
    });

    return sendSuccess(
      res,
      {
        checkoutUrl: session.url,
        sessionId: session.id,
        planType,
      },
      'Subscription checkout session created',
      201,
    );
  } catch (error) {
    // Handle specific error cases
    if (error.message?.includes('Stripe price ID not found')) {
      return sendError(res, 400, 'MISSING_PRICE_ID', error.message);
    }
    if (
      error.message?.includes('not a recurring price') ||
      error.message?.includes('recurring price')
    ) {
      return sendError(res, 400, 'INVALID_PRICE_TYPE', error.message);
    }
    if (error.message?.includes('not found in Stripe')) {
      return sendError(res, 400, 'PRICE_NOT_FOUND', error.message);
    }
    if (error.message?.includes('Stripe is not configured')) {
      return sendError(
        res,
        503,
        'STRIPE_NOT_CONFIGURED',
        'Payment processing unavailable',
      );
    }
    if (error.message?.includes('Stripe error:')) {
      return sendError(res, 400, 'STRIPE_ERROR', error.message);
    }
    if (error.message?.includes('Invalid plan type')) {
      return sendError(res, 400, 'INVALID_PLAN_TYPE', error.message);
    }

    logger.error('Subscribe error', {
      error: error.message,
      shopId: getStoreId(req),
    });
    next(error);
  }
}

/**
 * POST /api/subscriptions/update
 * Update subscription plan (upgrade/downgrade)
 * Body: { planType: 'starter' | 'pro' }
 */
export async function update(req, res, next) {
  try {
    const shopId = getStoreId(req);
    const { planType } = req.body;

    const subscription = await getSubscriptionStatus(shopId);

    if (!subscription.active || !subscription.stripeSubscriptionId) {
      return sendError(
        res,
        400,
        'NO_ACTIVE_SUBSCRIPTION',
        'No active subscription found. Please subscribe first.',
      );
    }

    // Check if already on the requested plan
    if (subscription.planType === planType) {
      return sendError(
        res,
        400,
        'ALREADY_ON_PLAN',
        `You are already on the ${planType} plan.`,
        {
          currentPlan: planType,
        },
      );
    }

    // Check if update is already in progress (idempotency check)
    // Get current subscription from Stripe to check metadata
    if (!stripe) {
      return sendError(
        res,
        503,
        'STRIPE_NOT_CONFIGURED',
        'Payment processing unavailable',
      );
    }

    let stripeSubscription = null;
    try {
      stripeSubscription = await stripe.subscriptions.retrieve(
        subscription.stripeSubscriptionId,
      );

      // Check if planType in Stripe already matches requested planType
      const stripeMetadata = stripeSubscription.metadata || {};
      const stripePlanType = stripeMetadata.planType;

      if (stripePlanType === planType && subscription.planType === planType) {
        logger.info(
          {
            shopId,
            subscriptionId: subscription.stripeSubscriptionId,
            planType,
          },
          'Subscription already on requested plan (idempotency check)',
        );

        return sendSuccess(
          res,
          {
            planType,
            alreadyUpdated: true,
          },
          `Subscription is already on the ${planType} plan`,
        );
      }
    } catch (err) {
      logger.warn(
        {
          subscriptionId: subscription.stripeSubscriptionId,
          err: err.message,
        },
        'Failed to retrieve subscription from Stripe for idempotency check',
      );
      // Continue with update anyway
    }

    await updateSubscription(subscription.stripeSubscriptionId, planType);

    // Update local DB immediately (idempotent - activateSubscription checks current state)
    await activateSubscription(
      shopId,
      subscription.stripeCustomerId,
      subscription.stripeSubscriptionId,
      planType,
    );

    logger.info(
      {
        shopId,
        oldPlan: subscription.planType,
        newPlan: planType,
        subscriptionId: subscription.stripeSubscriptionId,
      },
      'Subscription plan updated',
    );

    return sendSuccess(
      res,
      {
        planType,
      },
      `Subscription updated to ${planType} plan successfully`,
    );
  } catch (error) {
    logger.error('Update subscription error', {
      error: error.message,
      shopId: getStoreId(req),
    });
    next(error);
  }
}

/**
 * POST /api/subscriptions/cancel
 * Cancel subscription
 */
export async function cancel(req, res, next) {
  try {
    const shopId = getStoreId(req);

    const subscription = await getSubscriptionStatus(shopId);

    if (!subscription.active || !subscription.stripeSubscriptionId) {
      return sendError(
        res,
        400,
        'NO_ACTIVE_SUBSCRIPTION',
        'No active subscription found.',
      );
    }

    if (!stripe) {
      return sendError(
        res,
        503,
        'STRIPE_NOT_CONFIGURED',
        'Payment processing unavailable',
      );
    }

    // Cancel subscription in Stripe using service function
    await cancelSubscription(subscription.stripeSubscriptionId);

    // Update local DB immediately
    await deactivateSubscription(shopId, 'cancelled');

    logger.info(
      {
        shopId,
        subscriptionId: subscription.stripeSubscriptionId,
      },
      'Subscription cancelled',
    );

    return sendSuccess(
      res,
      {
        cancelledAt: new Date().toISOString(),
      },
      'Subscription cancelled successfully',
    );
  } catch (error) {
    logger.error('Cancel subscription error', {
      error: error.message,
      shopId: getStoreId(req),
    });
    next(error);
  }
}

/**
 * POST /api/subscriptions/verify-session
 * Manual verification of subscription payment
 * Body: { sessionId: string }
 */
export async function verifySession(req, res, next) {
  try {
    const shopId = getStoreId(req);
    const { sessionId } = req.body;

    if (!sessionId) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Session ID is required');
    }

    if (!stripe) {
      return sendError(
        res,
        503,
        'STRIPE_NOT_CONFIGURED',
        'Payment processing unavailable',
      );
    }

    // Retrieve session from Stripe
    const session = await getCheckoutSession(sessionId);

    // Verify session belongs to this shop
    const metadataShopId =
      session.metadata?.shopId || session.metadata?.storeId;
    if (metadataShopId !== shopId) {
      return sendError(
        res,
        403,
        'FORBIDDEN',
        'Session does not belong to this shop',
      );
    }

    // Check if subscription already active (idempotency)
    const currentSubscription = await getSubscriptionStatus(shopId);
    if (
      currentSubscription.active &&
      currentSubscription.stripeSubscriptionId
    ) {
      return sendSuccess(
        res,
        {
          subscription: currentSubscription,
          alreadyProcessed: true,
        },
        'Subscription already active',
      );
    }

    // Process subscription activation
    if (session.mode === 'subscription' && session.subscription) {
      const subscriptionId =
        typeof session.subscription === 'string'
          ? session.subscription
          : session.subscription.id;
      const customerId =
        typeof session.customer === 'string'
          ? session.customer
          : session.customer?.id;

      if (!subscriptionId || !customerId) {
        return sendError(
          res,
          400,
          'INVALID_SESSION',
          'Session does not contain valid subscription or customer information',
        );
      }

      // Retrieve subscription from Stripe
      const stripeSubscription =
        await stripe.subscriptions.retrieve(subscriptionId);
      const planType =
        session.metadata?.planType || stripeSubscription.metadata?.planType;

      if (!planType || !['starter', 'pro'].includes(planType)) {
        return sendError(
          res,
          400,
          'INVALID_PLAN_TYPE',
          'Invalid plan type in session',
        );
      }

      // Activate subscription
      await activateSubscription(shopId, customerId, subscriptionId, planType);

      // Allocate free credits
      const result = await allocateFreeCredits(
        shopId,
        planType,
        `sub_${subscriptionId}`,
        stripeSubscription,
      );

      return sendSuccess(
        res,
        {
          subscription: await getSubscriptionStatus(shopId),
          creditsAllocated: result.allocated ? result.credits : 0,
        },
        'Subscription verified and activated',
      );
    }

    return sendError(
      res,
      400,
      'INVALID_SESSION',
      'Session is not a subscription session',
    );
  } catch (error) {
    logger.error('Verify session error', {
      error: error.message,
      shopId: getStoreId(req),
    });
    next(error);
  }
}

/**
 * GET /api/subscriptions/portal
 * Get Stripe Customer Portal URL
 */
export async function getPortal(req, res, next) {
  try {
    const shopId = getStoreId(req);
    const subscription = await getSubscriptionStatus(shopId);
    if (!subscription.stripeCustomerId) {
      return sendError(
        res,
        400,
        'MISSING_CUSTOMER_ID',
        'No payment account found',
      );
    }

    const { getCustomerPortalUrl } = require('../services/stripe.js');
    const baseUrl =
      process.env.FRONTEND_URL ||
      process.env.WEB_APP_URL ||
      'http://localhost:3000';
    const returnUrl = `${baseUrl}/shopify/app/billing`;

    const portalUrl = await getCustomerPortalUrl(
      subscription.stripeCustomerId,
      returnUrl,
    );

    return sendSuccess(res, { portalUrl });
  } catch (error) {
    logger.error('Get portal error', {
      error: error.message,
      shopId: getStoreId(req),
    });
    next(error);
  }
}
