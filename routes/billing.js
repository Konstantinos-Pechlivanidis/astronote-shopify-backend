import express from 'express';
import * as ctrl from '../controllers/billing.js';
import { validateBody, validateQuery } from '../middlewares/validation.js';
import {
  createPurchaseSchema,
  transactionHistoryQuerySchema,
  billingHistoryQuerySchema,
  topupCalculateQuerySchema,
  topupCreateSchema,
} from '../schemas/billing.schema.js';
import { billingRateLimit } from '../middlewares/rateLimits.js';
import {
  billingBalanceCache,
  billingHistoryCache,
  invalidateBillingCache,
} from '../middlewares/cache.js';

const r = express.Router();

// Apply rate limiting to all routes
r.use(billingRateLimit);

// GET /billing/balance - Get credit balance
r.get('/balance', billingBalanceCache, ctrl.getBalance);

// GET /billing/packages - Get available credit packages (only if subscription active)
r.get('/packages', ctrl.getPackages);

// GET /billing/topup/calculate - Calculate top-up price
r.get(
  '/topup/calculate',
  validateQuery(topupCalculateQuerySchema),
  ctrl.calculateTopup,
);

// POST /billing/topup - Create top-up checkout session
r.post(
  '/topup',
  validateBody(topupCreateSchema),
  invalidateBillingCache,
  ctrl.createTopup,
);

// GET /billing/history - Get transaction history
r.get(
  '/history',
  validateQuery(transactionHistoryQuerySchema),
  billingHistoryCache,
  ctrl.getHistory,
);

// GET /billing/billing-history - Get billing history (Stripe transactions)
r.get(
  '/billing-history',
  validateQuery(billingHistoryQuerySchema),
  billingHistoryCache,
  ctrl.getBillingHistory,
);

// POST /billing/purchase - Create Stripe checkout session (credit packs - requires subscription)
r.post(
  '/purchase',
  validateBody(createPurchaseSchema),
  invalidateBillingCache,
  ctrl.createPurchase,
);

export default r;
