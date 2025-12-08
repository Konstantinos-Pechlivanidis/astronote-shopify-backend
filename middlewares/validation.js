import { ValidationError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

/**
 * Validation Middleware (Zod-based)
 *
 * This middleware validates request data against Zod schemas.
 * Provides better type safety and schema composition compared to express-validator.
 *
 * Used with Zod schemas defined in schemas/ directory (billing.schema.js, campaigns.schema.js, etc.)
 *
 * For legacy routes using express-validator, see middlewares/validate.js
 */

/**
 * Validate request body against schema
 * @param {Object} schema - Zod schema
 * @returns {Function} Express middleware
 */
export function validateBody(schema) {
  return async (req, res, next) => {
    try {
      // Ensure we have a body (even if empty)
      if (!req.body || typeof req.body !== 'object') {
        req.body = {};
      }

      const validated = await schema.parseAsync(req.body);
      req.body = validated;
      next();
    } catch (error) {
      if (error.name === 'ZodError' || error.issues) {
        // Handle both ZodError and error.issues format
        const zodErrors = error.issues || error.errors || [];
        const errors =
          Array.isArray(zodErrors) && zodErrors.length > 0
            ? zodErrors.map(err => ({
              field: (err.path || []).join('.') || null,
              message: err.message || 'Validation error',
            }))
            : [{ field: null, message: error.message || 'Validation failed' }];

        logger.warn('Validation error', {
          path: req.path,
          method: req.method,
          errors,
          body: req.body,
        });

        // Ensure we always return JSON, not HTML
        return next(new ValidationError('Validation failed', errors));
      }
      next(error);
    }
  };
}

/**
 * Validate request query parameters against schema
 * @param {Object} schema - Zod schema
 * @returns {Function} Express middleware
 */
export function validateQuery(schema) {
  return async (req, res, next) => {
    try {
      const validated = await schema.parseAsync(req.query);
      req.query = validated;
      next();
    } catch (error) {
      if (error.name === 'ZodError') {
        const errors = Array.isArray(error.errors)
          ? error.errors.map(err => ({
            field: err.path.join('.'),
            message: err.message,
          }))
          : [
            {
              field: null,
              message: error.message || 'Unknown validation error',
            },
          ];

        logger.warn('Query validation error', {
          path: req.path,
          errors,
          query: req.query,
        });

        return next(new ValidationError('Query validation failed', errors));
      }
      next(error);
    }
  };
}

/**
 * Validate request params against schema
 * @param {Object} schema - Zod schema
 * @returns {Function} Express middleware
 */
export function validateParams(schema) {
  return async (req, res, next) => {
    try {
      const validated = await schema.parseAsync(req.params);
      req.params = validated;
      next();
    } catch (error) {
      if (error.name === 'ZodError') {
        const errors = Array.isArray(error.errors)
          ? error.errors.map(err => ({
            field: err.path.join('.'),
            message: err.message,
          }))
          : [
            {
              field: null,
              message: error.message || 'Unknown validation error',
            },
          ];

        logger.warn('Params validation error', {
          path: req.path,
          errors,
          params: req.params,
        });

        return next(new ValidationError('Params validation failed', errors));
      }
      next(error);
    }
  };
}

export default {
  validateBody,
  validateQuery,
  validateParams,
};
