import prisma from '../services/prisma.js';
import { logger } from '../utils/logger.js';
import { ValidationError } from '../utils/errors.js';
import {
  verifyAppToken,
  verifyShopifySessionToken,
  generateAppToken,
} from '../services/auth.js';

/**
 * Store Resolution Middleware - Single Source of Truth
 *
 * This middleware extracts store information from various sources and ensures
 * all subsequent operations are scoped to the correct store (tenant).
 *
 * Sources (in order of precedence):
 * 1. JWT Token (Authorization: Bearer <token>) - App JWT or Shopify session token
 * 2. Shopify headers with shop domain
 * 3. App installation context
 * 4. Explicit store ID in headers (for internal services)
 */

export async function resolveStore(req, res, next) {
  try {
    let storeId = null;
    let shopDomain = null;
    let store = null;

    // Method 1: JWT Token Authentication (PRIORITY METHOD)
    // Check Authorization header for Bearer token
    if (
      req.headers.authorization &&
      req.headers.authorization.startsWith('Bearer ')
    ) {
      const token = req.headers.authorization.replace('Bearer ', '');

      try {
        // Try to verify as our app JWT token first
        const decoded = verifyAppToken(token);

        if (decoded.storeId) {
          storeId = decoded.storeId;
          store = await prisma.shop.findUnique({
            where: { id: storeId },
            include: { settings: true },
          });

          if (store) {
            shopDomain = store.shopDomain;
            logger.debug('Store resolved from app JWT token', {
              storeId,
              shopDomain,
            });
          } else {
            logger.warn('Store not found for storeId from JWT token', {
              storeId,
            });
            // If store not found but token has shopDomain, use it as fallback
            if (decoded.shopDomain) {
              shopDomain = decoded.shopDomain;
              logger.debug('Using shopDomain from JWT token as fallback', {
                shopDomain,
              });
            }
          }
        } else {
          logger.warn('JWT token decoded but no storeId found', { decoded });
          // If token has shopDomain but no storeId, use it
          if (decoded.shopDomain) {
            shopDomain = decoded.shopDomain;
            logger.debug('Using shopDomain from JWT token (no storeId)', {
              shopDomain,
            });
          }
        }
      } catch (jwtError) {
        // Not our app token, might be Shopify session token from App Bridge
        logger.debug(
          'App JWT token verification failed, trying Shopify session token',
          {
            error: jwtError.message,
            errorName: jwtError.name,
          },
        );

        try {
          const shopifySession = await verifyShopifySessionToken(token);

          // Generate app token and get store
          const { store: storeFromToken } = await generateAppToken(
            shopifySession.shop,
          );
          storeId = storeFromToken.id;
          shopDomain = shopifySession.shop;

          store = await prisma.shop.findUnique({
            where: { id: storeId },
            include: { settings: true },
          });

          if (store) {
            logger.debug('Store resolved from Shopify session token', {
              storeId,
              shopDomain,
            });
          } else {
            logger.warn(
              'Store not found for storeId from Shopify session token',
              { storeId, shopDomain },
            );
          }
        } catch (shopifyError) {
          // Neither token type worked, log for debugging but continue to fallback methods
          logger.debug(
            'Both token verification methods failed, falling back to headers',
            {
              jwtError: jwtError.message,
              jwtErrorName: jwtError.name,
              shopifyError: shopifyError.message,
              shopifyErrorName: shopifyError.name,
              hasAuthHeader: !!req.headers.authorization,
              tokenLength: token?.length,
              hasShopDomainHeader: !!req.headers['x-shopify-shop-domain'],
            },
          );
        }
      }
    } else {
      // No Authorization header, log for debugging
      logger.debug('No Authorization header found, using fallback methods', {
        hasShopDomainHeader: !!req.headers['x-shopify-shop-domain'],
        hasShopHeader: !!req.headers['x-shopify-shop'],
      });
    }

    // Method 2: Shopify Headers (backward compatible)
    // Check multiple possible sources for shop domain
    // Note: Express converts headers to lowercase, so we only check lowercase
    // If store was not found from token, or if shopDomain is not set, check headers
    if (!store || !shopDomain) {
      const possibleShopDomain =
        req.headers['x-shopify-shop-domain'] ||
        req.headers['x-shopify-shop'] ||
        req.headers['x-shopify-shop-name'] ||
        req.query.shop ||
        req.query.shop_domain ||
        req.query.shop_name ||
        req.body?.shop ||
        req.body?.shop_domain ||
        req.body?.shop_name;

      // Method 2.1: Extract shop domain from URL path (for embedded Shopify apps)
      // URL pattern: /store/{shop-domain}/apps/{app-name}/app
      let shopDomainFromPath = null;
      if (!possibleShopDomain && req.url) {
        const pathMatch = req.url.match(/\/store\/([^\\/]+)\//);
        if (pathMatch && pathMatch[1]) {
          shopDomainFromPath = pathMatch[1];
          // Ensure it has .myshopify.com suffix
          if (!shopDomainFromPath.includes('.')) {
            shopDomainFromPath = `${shopDomainFromPath}.myshopify.com`;
          }
        }
      }

      // Prioritize header shopDomain if provided (especially if store wasn't found from token)
      if (possibleShopDomain) {
        const headerShopDomain = possibleShopDomain;
        // Normalize shop domain
        const normalizedHeaderDomain = headerShopDomain.includes('.')
          ? headerShopDomain
          : `${headerShopDomain}.myshopify.com`;

        // Always use header shopDomain if:
        // 1. Store was not found from token (even if shopDomain was set from token)
        // 2. Header is explicitly provided (X-Shopify-Shop-Domain)
        // 3. No shopDomain was set from token
        if (!store || req.headers['x-shopify-shop-domain'] || !shopDomain) {
          shopDomain = normalizedHeaderDomain;
          logger.debug('Using shopDomain from header', {
            shopDomain,
            hadStoreFromToken: !!store,
            hadShopDomainFromToken: !!shopDomain,
            headerSource: req.headers['x-shopify-shop-domain']
              ? 'x-shopify-shop-domain'
              : 'other',
          });
        }
      } else if (shopDomainFromPath) {
        if (!shopDomain) {
          shopDomain = shopDomainFromPath;
        }
      } else if (!shopDomain) {
        // Try to extract from Shopify App Bridge session or JWT
        const shopifySession = req.session?.shopify || req.session?.shop;
        if (shopifySession) {
          shopDomain = shopifySession.shop || shopifySession.shopDomain;
          if (shopDomain && !shopDomain.includes('.')) {
            shopDomain = `${shopDomain}.myshopify.com`;
          }
        }
      }

      // Final validation - ensure shopDomain is a valid string
      if (
        !shopDomain ||
        typeof shopDomain !== 'string' ||
        shopDomain.trim() === ''
      ) {
        // No shop domain provided - shop domain is required in production
        logger.warn('No shop domain provided in headers, query, or body', {
          method: req.method,
          path: req.path,
          url: req.url,
          headers: Object.keys(req.headers).filter(h =>
            h.toLowerCase().includes('shop'),
          ),
          headerValues: {
            'x-shopify-shop-domain': req.headers['x-shopify-shop-domain'],
            'x-shopify-shop': req.headers['x-shopify-shop'],
            'x-shopify-shop-name': req.headers['x-shopify-shop-name'],
            authorization: req.headers.authorization ? 'Bearer ***' : undefined,
          },
          query: req.query,
          body: req.body ? Object.keys(req.body) : 'no body',
          possibleShopDomain,
          nodeEnv: process.env.NODE_ENV,
          hasToken: !!req.headers.authorization,
          storeResolved: !!store,
          shopDomainFromToken: shopDomain,
        });

        // In production, shop domain is required - fail if not provided
        logger.error('Shop domain is required in production mode');
      }

      // Normalize shopDomain (ensure it's a valid string)
      if (shopDomain && typeof shopDomain === 'string') {
        shopDomain = shopDomain.trim();
        // Ensure it has .myshopify.com suffix if it doesn't already
        if (shopDomain && !shopDomain.includes('.')) {
          shopDomain = `${shopDomain}.myshopify.com`;
        }
      }

      // Final validation - ensure shopDomain is a valid non-empty string after normalization
      if (
        !shopDomain ||
        typeof shopDomain !== 'string' ||
        shopDomain.trim() === ''
      ) {
        logger.error('Invalid shopDomain after all attempts', {
          shopDomain,
          type: typeof shopDomain,
          method: req.method,
          path: req.path,
          headers: Object.keys(req.headers).filter(h =>
            h.toLowerCase().includes('shop'),
          ),
          headerValues: {
            'x-shopify-shop-domain': req.headers['x-shopify-shop-domain'],
            'x-shopify-shop': req.headers['x-shopify-shop'],
            'x-shopify-shop-name': req.headers['x-shopify-shop-name'],
            authorization: req.headers.authorization ? 'Bearer ***' : undefined,
          },
          hadToken: !!req.headers.authorization,
          storeResolved: !!store,
        });
        return res.status(400).json({
          success: false,
          error: 'Invalid shop domain',
          message:
            'Unable to determine shop domain from request. Please provide X-Shopify-Shop-Domain header or Bearer token.',
          code: 'INVALID_SHOP_DOMAIN',
          apiVersion: 'v1',
        });
      }

      // Double-check shopDomain is valid before querying
      if (!shopDomain || typeof shopDomain !== 'string') {
        logger.error('shopDomain is invalid before Prisma query', {
          shopDomain,
          type: typeof shopDomain,
          possibleShopDomain,
        });
        return res.status(400).json({
          success: false,
          error: 'Invalid shop domain',
          message:
            'Unable to determine shop domain from request. Please provide X-Shopify-Shop-Domain header or Bearer token.',
          code: 'INVALID_SHOP_DOMAIN',
        });
      }

      try {
        store = await prisma.shop.findUnique({
          where: { shopDomain },
          include: {
            settings: true,
          },
        });

        if (store) {
          storeId = store.id;
        } else {
          // Auto-create store if it doesn't exist
          logger.info('Auto-creating new store', { shopDomain });

          store = await prisma.shop.create({
            data: {
              shopDomain,
              shopName: shopDomain.replace('.myshopify.com', ''),
              accessToken: req.headers['x-shopify-access-token'] || 'pending',
              credits: 100, // Give some initial credits
              currency: 'EUR',
              status: 'active',
              settings: {
                create: {
                  currency: 'EUR',
                  timezone: 'Europe/Athens',
                  senderNumber: process.env.MITTO_SENDER_NAME || 'Astronote',
                  senderName: process.env.MITTO_SENDER_NAME || 'Astronote',
                },
              },
            },
            include: {
              settings: true,
            },
          });

          storeId = store.id;
        }
      } catch (dbError) {
        logger.error('Database error during store resolution', {
          shopDomain,
          error: dbError.message,
        });
        throw dbError;
      }
    }

    // Development-only methods removed for production

    // Method 5: Explicit store ID in headers (for internal services)
    if (!store && req.headers['x-store-id']) {
      storeId = req.headers['x-store-id'];
      store = await prisma.shop.findUnique({
        where: { id: storeId },
        include: {
          settings: true,
        },
      });

      if (store) {
        shopDomain = store.shopDomain;
      }
    }

    // Validation: Ensure store was found
    if (!store || !storeId) {
      logger.warn('Store resolution failed', {
        headers: req.headers,
        query: req.query,
        url: req.url,
      });

      return res.status(401).json({
        success: false,
        error: 'Store not found',
        message:
          'Unable to resolve store context. Please ensure you are properly authenticated.',
        code: 'STORE_NOT_FOUND',
      });
    }

    // Attach store context to request
    req.ctx = {
      store: {
        id: store.id,
        shopDomain: store.shopDomain,
        credits: store.credits,
        currency: store.settings?.currency || 'EUR',
        timezone: store.settings?.timezone || 'UTC',
        senderNumber: store.settings?.senderNumber,
        senderName: store.settings?.senderName,
        settings: store.settings,
        createdAt: store.createdAt,
        updatedAt: store.updatedAt,
      },
    };

    // Add store context to logger for this request
    req.logger = logger;

    next();
  } catch (error) {
    logger.error('Store resolution middleware failed', {
      error: error.message,
      headers: req.headers,
      query: req.query,
    });

    res.status(500).json({
      success: false,
      error: 'Store resolution failed',
      message: 'Internal error during store resolution',
      code: 'STORE_RESOLUTION_ERROR',
    });
  }
}

/**
 * Middleware to ensure store context exists
 * Use this on routes that require store context
 */
export function requireStore(req, res, next) {
  if (!req.ctx?.store?.id) {
    return res.status(401).json({
      success: false,
      error: 'Store context required',
      message:
        'This endpoint requires store context. Please ensure you are properly authenticated.',
      code: 'STORE_CONTEXT_REQUIRED',
    });
  }
  next();
}

/**
 * Helper to get store ID from request context
 */
export function getStoreId(req) {
  if (!req.ctx?.store?.id) {
    // Provide more context in error message
    const endpoint = req.originalUrl || req.url || 'unknown';
    const action = endpoint.includes('settings')
      ? 'fetch settings'
      : endpoint.includes('automations')
        ? 'fetch automations'
        : endpoint.includes('account')
          ? 'fetch account information'
          : 'access this resource';
    throw new ValidationError(
      `Shop context is required to ${action}. Please ensure you are properly authenticated.`,
      400,
    );
  }
  return req.ctx.store.id;
}

/**
 * Helper to get store domain from request context
 */
export function getStoreDomain(req) {
  if (!req.ctx?.store?.shopDomain) {
    throw new Error('Store context not available');
  }
  return req.ctx.store.shopDomain;
}

/**
 * Helper to get full store context
 */
export function getStoreContext(req) {
  if (!req.ctx?.store) {
    throw new Error('Store context not available');
  }
  return req.ctx.store;
}

export default {
  resolveStore,
  requireStore,
  getStoreId,
  getStoreDomain,
  getStoreContext,
};
