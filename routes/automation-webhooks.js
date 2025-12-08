import express from 'express';
import * as ctrl from '../controllers/automation-webhooks.js';
import { validateShopifyWebhook } from '../middlewares/shopify-webhook.js';

const r = express.Router();

// Shopify webhook routes (no authentication required, but signature verification required)
r.post(
  '/shopify/orders/create',
  validateShopifyWebhook,
  ctrl.handleOrderCreated,
);
r.post(
  '/shopify/orders/fulfilled',
  validateShopifyWebhook,
  ctrl.handleOrderFulfilled,
);
r.post(
  '/shopify/cart/abandoned',
  validateShopifyWebhook,
  ctrl.handleCartAbandoned,
);

// Manual trigger route (for testing - no webhook validation)
r.post('/trigger', ctrl.triggerAutomationManually);

export default r;
