import express from 'express';
import * as ctrl from '../controllers/subscriptions.js';
import { validateBody } from '../middlewares/validation.js';
import {
  subscriptionSubscribeSchema,
  subscriptionUpdateSchema,
} from '../schemas/subscription.schema.js';

const r = express.Router();

// GET /subscriptions/status - Get subscription status
r.get('/status', ctrl.getStatus);

// POST /subscriptions/subscribe - Create subscription checkout
r.post('/subscribe', validateBody(subscriptionSubscribeSchema), ctrl.subscribe);

// POST /subscriptions/update - Update subscription plan
r.post('/update', validateBody(subscriptionUpdateSchema), ctrl.update);

// POST /subscriptions/cancel - Cancel subscription
r.post('/cancel', ctrl.cancel);

// POST /subscriptions/verify-session - Manual verification
r.post('/verify-session', ctrl.verifySession);

// GET /subscriptions/portal - Get Stripe Customer Portal URL
r.get('/portal', ctrl.getPortal);

export default r;
