import express from 'express';
import {
  getUnsubscribeInfo,
  processUnsubscribe,
} from '../controllers/unsubscribe.js';

const router = express.Router();

/**
 * Unsubscribe Routes
 * These routes are public and don't require authentication
 */

// GET /api/unsubscribe/:token - Get unsubscribe page info
router.get('/:token', getUnsubscribeInfo);

// POST /api/unsubscribe/:token - Process unsubscribe
router.post('/:token', processUnsubscribe);

export default router;
