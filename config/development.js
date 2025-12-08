/**
 * Development Configuration
 * Use this configuration for local development without Redis
 */

export default {
  // Server Configuration
  port: process.env.PORT || 3000,
  nodeEnv: 'development',

  // Database Configuration
  database: {
    url:
      process.env.DATABASE_URL ||
      'postgresql://username:password@localhost:5432/sendly_marketing',
    directUrl:
      process.env.DIRECT_URL ||
      'postgresql://username:password@localhost:5432/sendly_marketing',
  },

  // Redis Configuration (disabled for local development)
  redis: {
    enabled: false, // Disable Redis for local development
    url: null, // Will use memory cache instead
  },

  // Cache Configuration
  cache: {
    type: 'memory', // Use memory cache instead of Redis
    ttl: {
      short: 60, // 1 minute
      medium: 300, // 5 minutes
      long: 900, // 15 minutes
    },
  },

  // Shopify Configuration
  shopify: {
    apiKey: process.env.SHOPIFY_API_KEY || 'your_shopify_api_key',
    apiSecret: process.env.SHOPIFY_API_SECRET || 'your_shopify_api_secret',
    scopes: process.env.SCOPES || 'read_customers,write_customers,read_orders',
  },

  // Mitto SMS Configuration
  mitto: {
    apiBase: process.env.MITTO_API_BASE || 'https://messaging.mittoapi.com',
    apiKey: process.env.MITTO_API_KEY || 'your_mitto_api_key',
    trafficAccountId:
      process.env.MITTO_TRAFFIC_ACCOUNT_ID || 'your_traffic_account_id',
    senderName: process.env.MITTO_SENDER_NAME || 'Astronote',
  },

  // Application Configuration
  app: {
    host: process.env.HOST || 'http://localhost:3000',
    allowedOrigins:
      process.env.ALLOWED_ORIGINS ||
      'http://localhost:3000,http://localhost:3001',
    defaultCurrency: process.env.APP_DEFAULT_CURRENCY || 'EUR',
  },

  // Security Configuration
  security: {
    jwtSecret: process.env.JWT_SECRET || 'your_jwt_secret_key',
    sessionSecret: process.env.SESSION_SECRET || 'your_session_secret_key',
  },

  // Monitoring & Logging
  logging: {
    level: process.env.LOG_LEVEL || 'debug',
    sentryDsn: process.env.SENTRY_DSN || null,
  },
};
