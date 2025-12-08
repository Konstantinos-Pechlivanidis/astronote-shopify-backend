import express from 'express';
import { handleOptIn } from '../controllers/opt-in.js';
import { validateBody } from '../middlewares/validation.js';
import { optInSchema } from '../schemas/opt-in.schema.js';
import { rateLimitConfig } from '../config/security.js';

const router = express.Router();

/**
 * Public Opt-in Routes
 * No authentication required - used by storefront extensions
 */

// Apply rate limiting (stricter than general API)
router.use(rateLimitConfig.sms);

// POST /api/opt-in - Public opt-in endpoint
router.post('/', validateBody(optInSchema), handleOptIn);

export default router;
