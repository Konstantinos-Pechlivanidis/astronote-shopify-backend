import { validationResult } from 'express-validator';

/**
 * Validation Middleware (Express-Validator)
 *
 * This middleware handles validation results from express-validator.
 * Used primarily in legacy routes (audiences.js, shopify.js).
 *
 * For new routes, prefer the Zod-based validation in middlewares/validation.js
 * which provides better type safety and schema composition.
 */
export function handleValidation(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res
      .status(400)
      .json({ error: 'validation_error', details: errors.array() });
  }
  next();
}
