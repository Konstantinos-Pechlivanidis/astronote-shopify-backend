import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { logger } from '../utils/logger.js';
// hpp is used in app.js

// Rate limiting configurations
export const rateLimitConfig = {
  // General API rate limiting
  general: rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 1000, // limit each IP to 1000 requests per windowMs
    message: {
      error: 'Too many requests from this IP, please try again later.',
      retryAfter: 15 * 60, // 15 minutes in seconds
    },
    standardHeaders: true,
    legacyHeaders: false,
    skip: req => {
      // Skip rate limiting for health checks
      return req.path === '/health' || req.path === '/health/config';
    },
  }),

  // Strict rate limiting for authentication endpoints
  auth: rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // limit each IP to 5 requests per windowMs
    message: {
      error: 'Too many authentication attempts, please try again later.',
      retryAfter: 15 * 60,
    },
    standardHeaders: true,
    legacyHeaders: false,
  }),

  // SMS sending rate limiting
  sms: rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 10, // limit each IP to 10 SMS requests per minute
    message: {
      error: 'SMS rate limit exceeded, please try again later.',
      retryAfter: 60,
    },
    standardHeaders: true,
    legacyHeaders: false,
  }),

  // Webhook rate limiting
  webhook: rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 100, // limit each IP to 100 webhook requests per minute
    message: {
      error: 'Webhook rate limit exceeded.',
      retryAfter: 60,
    },
    standardHeaders: true,
    legacyHeaders: false,
  }),
};

// Helmet security configuration
export const helmetConfig = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
  },
  noSniff: true,
  xssFilter: true,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
});

// CORS configuration
export const corsConfig = {
  origin: (origin, callback) => {
    const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || [
      'https://astronote-shopify-backend.onrender.com',
      'https://astronote-shopify-frontend.onrender.com',
    ];

    // Allow requests with no origin (mobile apps, Postman, etc.)
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-API-Key',
    'X-Request-ID',
    'API-Version',
    'X-Shopify-Shop-Domain',
    'X-Shopify-Access-Token',
  ],
  exposedHeaders: [
    'X-Request-ID',
    'X-Rate-Limit-Remaining',
    'X-Rate-Limit-Reset',
  ],
  maxAge: 86400, // 24 hours
};

// Input validation and sanitization
export const inputValidation = {
  // Sanitize request body
  sanitizeBody: (req, res, next) => {
    if (req.body && typeof req.body === 'object') {
      // Remove potentially dangerous properties
      const dangerousProps = ['__proto__', 'constructor', 'prototype'];
      dangerousProps.forEach(prop => {
        delete req.body[prop];
      });

      // Limit object depth
      const limitDepth = (obj, depth = 0, maxDepth = 10) => {
        if (depth > maxDepth) return '[Object too deep]';
        if (typeof obj !== 'object' || obj === null) return obj;

        const result = {};
        for (const key in obj) {
          if (Object.prototype.hasOwnProperty.call(obj, key)) {
            result[key] = limitDepth(obj[key], depth + 1, maxDepth);
          }
        }
        return result;
      };

      req.body = limitDepth(req.body);
    }
    next();
  },

  // Validate content type
  validateContentType: (req, res, next) => {
    if (
      req.method === 'POST' ||
      req.method === 'PUT' ||
      req.method === 'PATCH'
    ) {
      const contentType = req.get('Content-Type');
      if (!contentType || !contentType.includes('application/json')) {
        return res.status(400).json({
          error: 'Invalid content type. Expected application/json.',
        });
      }
    }
    next();
  },

  // Validate request size
  validateRequestSize:
    (maxSize = 5 * 1024 * 1024) =>
      (req, res, next) => {
        const contentLength = parseInt(req.get('Content-Length') || '0');
        if (contentLength > maxSize) {
          return res.status(413).json({
            error: 'Request entity too large.',
            maxSize: `${maxSize / 1024 / 1024}MB`,
          });
        }
        next();
      },
};

// Security headers middleware
export const securityHeaders = (req, res, next) => {
  // Remove X-Powered-By header
  res.removeHeader('X-Powered-By');

  // Add security headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader(
    'Permissions-Policy',
    'geolocation=(), microphone=(), camera=()',
  );

  // Add request ID for tracking
  if (!res.getHeader('X-Request-ID')) {
    res.setHeader('X-Request-ID', req.id || 'unknown');
  }

  next();
};

// API key validation middleware
export const validateApiKey = (req, res, next) => {
  const apiKey = req.get('X-API-Key');
  const validApiKey = process.env.API_KEY;

  if (!validApiKey) {
    return next(); // Skip validation if no API key is configured
  }

  if (!apiKey || apiKey !== validApiKey) {
    return res.status(401).json({
      error: 'Invalid or missing API key.',
    });
  }

  next();
};

// Shopify webhook validation
export const validateShopifyWebhook = (req, res, next) => {
  const hmac = req.get('X-Shopify-Hmac-Sha256');
  const shop = req.get('X-Shopify-Shop-Domain');

  if (!hmac || !shop) {
    return res.status(401).json({
      error: 'Missing Shopify webhook headers.',
    });
  }

  // Note: HMAC validation is implemented in middlewares/shopify-webhook.js
  // This middleware is a placeholder for additional security checks if needed
  // For Shopify webhooks, use validateShopifyWebhook from shopify-webhook.js

  next();
};

// Request logging for security monitoring
export const securityLogger = (req, res, next) => {
  const startTime = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - startTime;
    const logData = {
      method: req.method,
      url: req.url,
      statusCode: res.statusCode,
      duration,
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      referer: req.get('Referer'),
      requestId: req.id,
    };

    // Log suspicious activity
    if (res.statusCode >= 400) {
      logger.warn('Security event detected', logData);
    }

    // Log potential attacks
    if (
      req.url.includes('..') ||
      req.url.includes('<script>') ||
      req.url.includes('javascript:')
    ) {
      logger.error('Potential attack detected', logData);
    }
  });

  next();
};

// IP whitelist middleware (optional)
export const ipWhitelist = (allowedIPs = []) => {
  return (req, res, next) => {
    if (allowedIPs.length === 0) {
      return next(); // Skip if no whitelist configured
    }

    const clientIP = req.ip || req.connection.remoteAddress;

    if (!allowedIPs.includes(clientIP)) {
      return res.status(403).json({
        error: 'Access denied from this IP address.',
      });
    }

    next();
  };
};
