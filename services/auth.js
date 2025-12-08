import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import '@shopify/shopify-api/adapters/node'; // Node.js runtime adapter
import { shopifyApi } from '@shopify/shopify-api';
import prisma from './prisma.js';
import { logger } from '../utils/logger.js';

/**
 * Authentication Service
 * Handles JWT token generation/verification and Shopify session token validation
 */

let shopifyApiInstance = null;

/**
 * Get or initialize Shopify API instance
 */
function getShopifyApi() {
  if (!shopifyApiInstance) {
    const { SHOPIFY_API_KEY, SHOPIFY_API_SECRET, HOST } = process.env;

    if (!SHOPIFY_API_KEY || !SHOPIFY_API_SECRET) {
      throw new Error('Shopify API credentials not configured');
    }

    shopifyApiInstance = shopifyApi({
      apiKey: SHOPIFY_API_KEY,
      apiSecretKey: SHOPIFY_API_SECRET,
      scopes: process.env.SCOPES?.split(',') || ['read_products'],
      hostName: HOST?.replace(/^https?:\/\//, '').split('/')[0] || 'localhost',
      apiVersion: '2024-04',
      isEmbeddedApp: true,
    });
  }
  return shopifyApiInstance;
}

/**
 * Verify Shopify session token from App Bridge
 * @param {string} sessionToken - JWT token from Shopify App Bridge
 * @returns {Promise<Object>} Decoded token with shop domain
 */
export async function verifyShopifySessionToken(sessionToken) {
  try {
    const api = getShopifyApi();

    // Decode the session token (Shopify App Bridge JWT)
    // The token is signed by Shopify and contains shop information
    const payload = await api.session.decodeSessionToken(sessionToken);

    // Extract shop domain from destination URL
    const shopDomain =
      payload.dest?.replace('https://', '').replace('http://', '') ||
      payload.shop;

    if (!shopDomain) {
      throw new Error('Shop domain not found in session token');
    }

    logger.info('Shopify session token verified', {
      shop: shopDomain,
      sub: payload.sub,
      exp: payload.exp,
    });

    return {
      shop: shopDomain,
      userId: payload.sub,
      exp: payload.exp,
      iss: payload.iss,
    };
  } catch (error) {
    logger.error('Failed to verify Shopify session token', {
      error: error.message,
    });
    throw new Error('Invalid Shopify session token');
  }
}

/**
 * Generate app JWT token from shop domain
 * This token can be used by both Shopify extension and web app
 * @param {string} shopDomain - Shop domain from Shopify session
 * @returns {Promise<Object>} JWT token and store info
 */
export async function generateAppToken(shopDomain) {
  try {
    // Normalize shop domain
    const normalizedDomain = shopDomain.includes('.myshopify.com')
      ? shopDomain
      : `${shopDomain}.myshopify.com`;

    // Find store in database with retry logic
    let store;
    let retries = 3;
    let lastError;

    while (retries > 0) {
      try {
        store = await prisma.shop.findUnique({
          where: { shopDomain: normalizedDomain },
          select: {
            id: true,
            shopDomain: true,
            credits: true,
            currency: true,
          },
        });
        break; // Success
      } catch (dbError) {
        lastError = dbError;
        retries--;

        if (
          (dbError.message?.includes('closed') ||
            dbError.message?.includes('connection') ||
            dbError.code === 'P1001' ||
            dbError.code === 'P1017') &&
          retries > 0
        ) {
          logger.warn(
            'Database connection error in generateAppToken, retrying...',
            {
              shopDomain: normalizedDomain,
              retriesLeft: retries,
              error: dbError.message,
            },
          );

          await new Promise(resolve =>
            setTimeout(resolve, 1000 * (4 - retries)),
          );
          continue;
        }

        throw dbError;
      }
    }

    if (!store && lastError) {
      throw lastError;
    }

    if (!store) {
      logger.warn('Store not found for token generation', {
        shopDomain: normalizedDomain,
      });
      throw new Error('Store not found');
    }

    // Generate JWT token with storeId
    const token = jwt.sign(
      {
        storeId: store.id,
        shopDomain: store.shopDomain,
        source: 'auth_service',
      },
      process.env.JWT_SECRET,
      {
        expiresIn: '30d', // Long-lived token
      },
    );

    logger.info('App token generated', {
      storeId: store.id,
      shopDomain: store.shopDomain,
    });

    return {
      token,
      store: {
        id: store.id,
        shopDomain: store.shopDomain,
        credits: store.credits,
        currency: store.currency,
      },
    };
  } catch (error) {
    logger.error('Failed to generate app token', {
      error: error.message,
      shopDomain,
    });
    throw error;
  }
}

/**
 * Verify app JWT token
 * @param {string} token - JWT token
 * @returns {Object} Decoded token payload
 */
export function verifyAppToken(token) {
  try {
    if (!process.env.JWT_SECRET) {
      throw new Error('JWT_SECRET not configured');
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    logger.debug('App token verified', {
      storeId: decoded.storeId,
      source: decoded.source,
    });

    return decoded;
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      logger.warn('App token expired', { error: error.message });
      throw new Error('Token expired');
    }

    logger.warn('Invalid app token', { error: error.message });
    throw new Error('Invalid token');
  }
}

/**
 * Verify Shopify OAuth HMAC signature
 * @param {Object} query - Query parameters from OAuth callback
 * @returns {boolean} True if HMAC is valid
 */
export function verifyShopifyHmac(query) {
  try {
    // Extract hmac from query params for comparison
    // eslint-disable-next-line no-unused-vars
    const { hmac, signature: _signature, ...params } = query;

    // Sort and create query string
    const queryString = Object.keys(params)
      .sort()
      .map(key => `${key}=${params[key]}`)
      .join('&');

    // Calculate HMAC
    const hash = crypto
      .createHmac('sha256', process.env.SHOPIFY_API_SECRET)
      .update(queryString)
      .digest('hex');

    const isValid = hash === hmac;

    if (!isValid) {
      logger.warn('Shopify HMAC verification failed', {
        shop: params.shop,
      });
    }

    return isValid;
  } catch (error) {
    logger.error('HMAC verification error', {
      error: error.message,
    });
    return false;
  }
}

export default {
  verifyShopifySessionToken,
  generateAppToken,
  verifyAppToken,
  verifyShopifyHmac,
};
