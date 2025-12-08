import { logger } from '../utils/logger.js';

/**
 * Environment Variable Validation
 * Validates required environment variables on startup
 */

const REQUIRED_ENV_VARS = {
  production: [
    'DATABASE_URL',
    'SHOPIFY_API_KEY',
    'SHOPIFY_API_SECRET',
    'STRIPE_SECRET_KEY',
  ],
  development: ['DATABASE_URL'],
  test: ['DATABASE_URL'],
};

const OPTIONAL_ENV_VARS = {
  production: [
    'REDIS_URL',
    'MITTO_API_KEY',
    'MITTO_API_BASE',
    'STRIPE_WEBHOOK_SECRET',
    'JWT_SECRET',
    'SESSION_SECRET',
    'LOG_LEVEL',
    'SENTRY_DSN',
    'HOST',
    'ALLOWED_ORIGINS',
  ],
  development: [
    'REDIS_URL',
    'SHOPIFY_API_KEY',
    'SHOPIFY_API_SECRET',
    'MITTO_API_KEY',
    'STRIPE_SECRET_KEY',
  ],
  test: ['REDIS_URL', 'SHOPIFY_API_KEY', 'SHOPIFY_API_SECRET'],
};

/**
 * Validate environment variables
 * @param {string} env - Environment (production, development, test)
 * @returns {Object} Validation result
 */
export function validateEnvironment(
  env = process.env.NODE_ENV || 'development',
) {
  const required = REQUIRED_ENV_VARS[env] || REQUIRED_ENV_VARS.development;
  const optional = OPTIONAL_ENV_VARS[env] || OPTIONAL_ENV_VARS.development;

  const missing = [];
  const warnings = [];

  // Check required variables
  for (const varName of required) {
    if (!process.env[varName]) {
      missing.push(varName);
    }
  }

  // Check optional variables and warn if missing in production
  if (env === 'production') {
    for (const varName of optional) {
      if (!process.env[varName]) {
        warnings.push(varName);
      }
    }
  }

  return {
    valid: missing.length === 0,
    missing,
    warnings,
    environment: env,
  };
}

/**
 * Validate and log environment configuration
 * Throws error if required variables are missing
 */
export function validateAndLogEnvironment() {
  const env = process.env.NODE_ENV || 'development';
  const validation = validateEnvironment(env);

  if (!validation.valid) {
    logger.error('Missing required environment variables', {
      environment: env,
      missing: validation.missing,
    });

    throw new Error(
      `Missing required environment variables: ${validation.missing.join(', ')}\n` +
        'Please check your .env file or environment configuration.',
    );
  }

  if (validation.warnings.length > 0) {
    logger.warn(
      'Missing optional environment variables (recommended for production)',
      {
        environment: env,
        missing: validation.warnings,
      },
    );
  }

  logger.info('Environment validation passed', {
    environment: env,
    required: validation.missing.length === 0,
    optional: validation.warnings.length,
  });

  return validation;
}

/**
 * Get environment variable with validation
 * @param {string} name - Variable name
 * @param {string} defaultValue - Default value
 * @param {boolean} required - Whether variable is required
 * @returns {string} Environment variable value
 */
export function getEnv(name, defaultValue = null, required = false) {
  const value = process.env[name];

  if (required && !value) {
    throw new Error(`Required environment variable ${name} is not set`);
  }

  return value || defaultValue;
}

export default {
  validateEnvironment,
  validateAndLogEnvironment,
  getEnv,
};
