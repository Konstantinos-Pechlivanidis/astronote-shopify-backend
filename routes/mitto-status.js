// routes/mitto-status.js
// Routes for on-demand Mitto status refresh (debugging/UI)

import { Router } from 'express';
import * as ctrl from '../controllers/mitto-status.js';
import { resolveStore, requireStore } from '../middlewares/store-resolution.js';

const router = Router();

// POST /api/mitto/refresh-status - Refresh single message status
router.post('/refresh-status', resolveStore, requireStore, ctrl.refreshStatus);

// POST /api/mitto/refresh-status-bulk - Refresh multiple message statuses
router.post(
  '/refresh-status-bulk',
  resolveStore,
  requireStore,
  ctrl.refreshStatusBulk,
);

// GET /api/mitto/message/:messageId - Get message status (read-only)
router.get('/message/:messageId', resolveStore, requireStore, ctrl.getStatus);

export default router;

