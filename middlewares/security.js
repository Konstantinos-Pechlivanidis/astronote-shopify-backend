import rateLimit from 'express-rate-limit';
import { body, param, query } from 'express-validator';
import { validationResult } from 'express-validator';

// Advanced rate limiting with different strategies
export const createRateLimit = (options = {}) => {
  const defaultOptions = {
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
    message: {
      error: 'too_many_requests',
      message: 'Too many requests from this IP, please try again later.',
      retryAfter: Math.ceil(options.windowMs / 1000),
    },
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: false,
    skipFailedRequests: false,
    ...options,
  };
  return rateLimit(defaultOptions);
};

// Strict rate limiting for sensitive operations
export const strictRateLimit = createRateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 10, // 10 requests per 5 minutes
  message: {
    error: 'rate_limit_exceeded',
    message: 'Too many sensitive operations. Please wait before trying again.',
  },
});

// API key validation middleware
export const validateApiKey = (req, res, next) => {
  const apiKey =
    req.headers['x-api-key'] ||
    req.headers['authorization']?.replace('Bearer ', '');

  if (!apiKey) {
    return res.status(401).json({
      error: 'missing_api_key',
      message: 'API key is required',
    });
  }

  // In production, validate against database or external service
  // For now, we'll use a simple environment variable check
  const validApiKey = process.env.API_KEY || 'dev-key-123';

  if (apiKey !== validApiKey) {
    return res.status(401).json({
      error: 'invalid_api_key',
      message: 'Invalid API key',
    });
  }

  next();
};

// Request sanitization middleware
export const sanitizeRequest = (req, res, next) => {
  // Remove potentially dangerous characters and normalize input
  const sanitizeString = str => {
    if (typeof str !== 'string') return str;
    return str
      .replace(/[<>]/g, '') // Remove potential HTML/XML tags
      .replace(/javascript:/gi, '') // Remove javascript: protocol
      .replace(/on\w+=/gi, '') // Remove event handlers
      .trim();
  };

  // Sanitize body
  if (req.body && typeof req.body === 'object') {
    const sanitizeObject = obj => {
      for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
          if (typeof obj[key] === 'string') {
            obj[key] = sanitizeString(obj[key]);
          } else if (typeof obj[key] === 'object' && obj[key] !== null) {
            sanitizeObject(obj[key]);
          }
        }
      }
    };
    sanitizeObject(req.body);
  }

  // Sanitize query parameters
  if (req.query && typeof req.query === 'object') {
    for (const key in req.query) {
      if (typeof req.query[key] === 'string') {
        req.query[key] = sanitizeString(req.query[key]);
      }
    }
  }

  next();
};

// Advanced validation rules
export const validationRules = {
  // Contact validation
  contact: [
    body('firstName')
      .optional()
      .isString()
      .isLength({ min: 1, max: 50 })
      .trim(),
    body('lastName').optional().isString().isLength({ min: 1, max: 50 }).trim(),
    body('phoneE164')
      .isString()
      .matches(/^\+[1-9]\d{1,14}$/)
      .withMessage('Invalid E.164 phone number'),
    body('email').optional().isEmail().normalizeEmail(),
    body('gender').optional().isIn(['male', 'female', 'other']),
    body('smsConsent').isIn(['opted_in', 'opted_out', 'unknown']),
    body('tags')
      .optional()
      .isArray()
      .custom(tags => {
        if (tags && tags.length > 10) {
          throw new Error('Maximum 10 tags allowed');
        }
        return true;
      }),
  ],

  // Campaign validation
  campaign: [
    body('name').isString().isLength({ min: 1, max: 100 }).trim(),
    body('message').isString().isLength({ min: 1, max: 1600 }).trim(),
    body('audience')
      .isString()
      .matches(/^(all|men|women|segment:[a-zA-Z0-9]+)$/),
    body('scheduleType')
      .optional()
      .isIn(['immediate', 'scheduled', 'recurring']),
    body('scheduleAt').optional().isISO8601().toDate(),
    body('recurringDays').optional().isInt({ min: 1, max: 365 }),
  ],

  // Template validation
  template: [
    body('templateId').isString().isLength({ min: 1, max: 50 }),
    body('sampleData').optional().isObject(),
  ],

  // Pagination validation
  pagination: [
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
    query('sort')
      .optional()
      .isString()
      .isIn(['createdAt', 'updatedAt', 'name']),
    query('order').optional().isString().isIn(['asc', 'desc']),
  ],

  // ID parameter validation
  id: [
    param('id')
      .isString()
      .isLength({ min: 1, max: 50 })
      .matches(/^[a-zA-Z0-9_-]+$/),
  ],
};

// Enhanced validation handler
export const handleValidation = (req, res, next) => {
  const errors = validationResult(req);

  if (!errors.isEmpty()) {
    const formattedErrors = errors.array().map(error => ({
      field: error.path || error.param,
      message: error.msg,
      value: error.value,
    }));

    return res.status(400).json({
      error: 'validation_error',
      message: 'Request validation failed',
      details: formattedErrors,
    });
  }

  next();
};

// Content-Type validation
export const validateContentType = (req, res, next) => {
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
    const contentType = req.headers['content-type'];
    const contentLength = parseInt(req.headers['content-length'] || '0', 10);

    // Allow specific routes that don't require a body
    const noBodyRoutes = [
      '/campaigns/:id/send',
      '/campaigns/:id/retry-failed',
      '/campaigns/:id/prepare',
      '/templates/:id/track',
      '/automations/sync',
    ];

    // Check if this is a no-body route
    const isNoBodyRoute = noBodyRoutes.some(route => {
      const routePattern = route.replace(/:id/g, '[^/]+');
      const regex = new RegExp(`^${routePattern.replace(/\//g, '\\/')}$`);
      return regex.test(req.path);
    });

    // Allow requests without body or with empty body (Content-Length: 0 or 2 for "{}")
    // Some endpoints like /campaigns/:id/send don't require a body
    if (isNoBodyRoute || contentLength === 0 || contentLength <= 2) {
      return next();
    }

    if (!contentType || !contentType.includes('application/json')) {
      return res.status(400).json({
        error: 'invalid_content_type',
        message: 'Content-Type must be application/json',
      });
    }
  }

  next();
};

// Request size validation
export const validateRequestSize = (maxSize = 1024 * 1024) => {
  // 1MB default
  return (req, res, next) => {
    const contentLength = parseInt(req.headers['content-length'] || '0');

    if (contentLength > maxSize) {
      return res.status(413).json({
        error: 'request_too_large',
        message: `Request size exceeds ${maxSize} bytes`,
      });
    }

    next();
  };
};
