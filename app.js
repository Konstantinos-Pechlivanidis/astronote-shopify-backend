import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import morgan from 'morgan';
import compression from 'compression';
import hpp from 'hpp';
import { initShopifyContext } from './services/shopify.js';
import {
  logger,
  requestId,
  performanceMonitor,
  securityMonitor,
} from './utils/logger.js';
import { globalErrorHandler, notFoundHandler } from './utils/errors.js';
import {
  apiVersioning,
  backwardCompatibility,
  versionedResponse,
} from './middlewares/versioning.js';
import {
  sanitizeRequest,
  validateContentType,
  validateRequestSize,
} from './middlewares/security.js';
import { metricsMiddleware } from './utils/metrics.js';
import coreRoutes from './routes/core.js';
import dashboardRoutes from './routes/dashboard.js';
import contactsRoutes from './routes/contacts-enhanced.js';
import campaignsRoutes from './routes/campaigns.js';
import templatesRoutes from './routes/templates.js';
import adminTemplatesRoutes from './routes/admin-templates.js';
import automationsRoutes from './routes/automations.js';
import automationWebhookRoutes from './routes/automation-webhooks.js';
import reportsRoutes from './routes/reports.js';
import discountsRoutes from './routes/discounts.js';
import billingRoutes from './routes/billing.js';
import subscriptionRoutes from './routes/subscriptions.js';
import mittoRoutes from './routes/mitto.js';
import mittoStatusRoutes from './routes/mitto-status.js';
import trackingRoutes from './routes/tracking.js';
import settingsRoutes from './routes/settings.js';
import stripeWebhookRoutes from './routes/stripe-webhooks.js';
import audiencesRoutes from './routes/audiences.js';
import shopifyRoutes from './routes/shopify.js';
import docsRoutes from './routes/docs.js';
import authRoutes from './routes/auth.js';
import unsubscribeRoutes from './routes/unsubscribe.js';
import optInRoutes from './routes/opt-in.js';
// import { setDevShop } from './middlewares/dev-shop.js'; // Not used in current implementation
import { resolveStore, requireStore } from './middlewares/store-resolution.js';

initShopifyContext();

const app = express();

// Trust proxy for accurate IP addresses
app.set('trust proxy', 1);

// Security middleware
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'https:'],
      },
    },
    crossOriginEmbedderPolicy: false,
  }),
);

app.use(hpp());
app.use(compression());

// Request processing
app.use(requestId);
app.use(performanceMonitor);
app.use(securityMonitor);
app.use(metricsMiddleware);
app.use(sanitizeRequest);
app.use(validateContentType);
app.use(validateRequestSize(5 * 1024 * 1024)); // 5MB limit

// API versioning
app.use(apiVersioning);
app.use(backwardCompatibility);
app.use(versionedResponse);

// CORS configuration
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, Postman, etc.)
      if (!origin) return callback(null, true);

      const allowedOrigins = [
        'https://admin.shopify.com',
        'https://astronote-shopify-frontend.onrender.com',
        ...(process.env.ALLOWED_ORIGINS
          ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
          : []),
      ];

      // Allow all myshopify.com subdomains (for storefront theme extensions)
      const isShopifyStorefront = origin.match(
        /^https:\/\/[a-zA-Z0-9-]+\.myshopify\.com$/,
      );

      // Allow Shopify admin domains (for embedded apps)
      const isShopifyAdmin = origin.match(/^https:\/\/admin\.shopify\.com$/);

      if (
        allowedOrigins.includes(origin) ||
        isShopifyStorefront ||
        isShopifyAdmin
      ) {
        callback(null, true);
      } else {
        logger.warn(`CORS blocked origin: ${origin}`);
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
      'X-Shopify-Shop',
      'X-Shopify-Shop-Name',
      'X-Store-ID',
      'X-Client-Version',
      'X-Client-Platform',
      'X-Requested-With',
      'Accept',
      'Origin',
    ],
    exposedHeaders: [
      'X-Request-ID',
      'X-Rate-Limit-Remaining',
      'X-Rate-Limit-Reset',
    ],
    maxAge: 86400, // 24 hours for preflight cache
  }),
);

// Body parsing with error handling
app.use(
  express.json({
    limit: '5mb',
    verify: (req, res, buf) => {
      // Store raw body for webhook verification
      req.rawBody = buf;
    },
  }),
);
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

// Handle JSON parsing errors
app.use((error, req, res, next) => {
  if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
    // JSON parsing error
    return res.status(400).json({
      success: false,
      error: 'invalid_json',
      message: 'Invalid JSON in request body',
      path: req.originalUrl || req.url,
    });
  }
  next(error);
});

// Logging
app.use(
  morgan('combined', {
    stream: {
      write: message => logger.info(message.trim()),
    },
  }),
);

// mount
app.use('/', mittoRoutes); // Mitto webhooks (no auth)
app.use('/api/mitto', resolveStore, requireStore, mittoStatusRoutes); // Mitto status refresh (requires auth)
app.use('/', coreRoutes); // health, webhooks, auth helpers
app.use('/api/opt-in', optInRoutes); // Public opt-in endpoint (no auth)
if (process.env.NODE_ENV !== 'production') app.use('/', docsRoutes); // Swagger UI (dev only)

// Authentication routes (no store context required - handles authentication)
app.use('/auth', authRoutes);

// Store-scoped routes (require store context)
app.use('/dashboard', resolveStore, requireStore, dashboardRoutes);
app.use('/contacts', resolveStore, requireStore, contactsRoutes);
app.use('/campaigns', resolveStore, requireStore, campaignsRoutes);
app.use('/automations', resolveStore, requireStore, automationsRoutes);
app.use('/reports', resolveStore, requireStore, reportsRoutes);
app.use('/discounts', resolveStore, requireStore, discountsRoutes);
app.use('/billing', resolveStore, requireStore, billingRoutes);
app.use('/subscriptions', resolveStore, requireStore, subscriptionRoutes);
app.use('/settings', resolveStore, requireStore, settingsRoutes);
app.use('/audiences', resolveStore, requireStore, audiencesRoutes);
app.use('/shopify', resolveStore, requireStore, shopifyRoutes);

// Public routes (no store context required)
// Note: /templates/:id/track requires store context, so apply resolveStore
app.use('/templates', resolveStore, templatesRoutes);
app.use('/unsubscribe', unsubscribeRoutes); // Unsubscribe (public, no auth required)

// Tracking routes (require store context for security)
app.use('/tracking', resolveStore, requireStore, trackingRoutes); // ✅ Tracking endpoints now require store context

// Webhook routes (no store context - validated by webhook signatures)
app.use('/automation-webhooks', automationWebhookRoutes); // Automation webhooks
app.use('/webhooks/stripe', stripeWebhookRoutes); // Stripe webhooks

// Admin routes (special handling)
app.use('/admin/templates', resolveStore, requireStore, adminTemplatesRoutes);

// Error handling - ensure JSON responses
app.use(notFoundHandler);

// Global error handler - must be last
app.use((error, req, res, next) => {
  // Ensure we always return JSON, not HTML
  if (res.headersSent) {
    return next(error);
  }

  // Call our custom error handler
  return globalErrorHandler(error, req, res, next);
});

// Note: Graceful shutdown is handled in index.js
// This ensures proper cleanup of all connections (Redis, Prisma, etc.)

export default app;
