import express from 'express';
import {
  list,
  getOne,
  create,
  update,
  remove,
  stats,
  getBirthdayContacts,
  importCsv,
} from '../controllers/contacts-enhanced.js';
import { validateBody, validateQuery } from '../middlewares/validation.js';
import {
  createContactSchema,
  updateContactSchema,
  listContactsQuerySchema,
  importContactsSchema,
  birthdayContactsQuerySchema,
} from '../schemas/contacts.schema.js';
import {
  contactsRateLimit,
  importRateLimit,
} from '../middlewares/rateLimits.js';
import {
  contactsListCache,
  contactsStatsCache,
  invalidateContactsCache,
} from '../middlewares/cache.js';

const router = express.Router();

/**
 * Enhanced Contacts Routes with Multi-Store Support
 *
 * All routes are automatically scoped to the current store via middleware
 * All routes include input validation, rate limiting, and caching
 */

// Apply rate limiting to all routes
router.use(contactsRateLimit);

// GET /api/contacts - List contacts with filtering, search, and pagination
router.get(
  '/',
  validateQuery(listContactsQuerySchema),
  contactsListCache,
  list,
);

// GET /api/contacts/stats - Get contact statistics
router.get('/stats', contactsStatsCache, stats);

// GET /api/contacts/birthdays - Get contacts with birthdays
router.get(
  '/birthdays',
  validateQuery(birthdayContactsQuerySchema),
  getBirthdayContacts,
);

// GET /api/contacts/:id - Get single contact
router.get('/:id', getOne);

// POST /api/contacts - Create new contact
router.post(
  '/',
  validateBody(createContactSchema),
  invalidateContactsCache,
  create,
);

// POST /api/contacts/import - Import contacts from CSV (stricter rate limit)
router.post(
  '/import',
  importRateLimit,
  validateBody(importContactsSchema),
  invalidateContactsCache,
  importCsv,
);

// PUT /api/contacts/:id - Update contact
router.put(
  '/:id',
  validateBody(updateContactSchema),
  invalidateContactsCache,
  update,
);

// DELETE /api/contacts/:id - Delete contact
router.delete('/:id', invalidateContactsCache, remove);

export default router;
