import { getDiscountCodes, getDiscountCode } from '../services/shopify.js';
import { logger } from '../utils/logger.js';
import { sendSuccess } from '../utils/response.js';
import { ValidationError } from '../utils/errors.js';

/**
 * Get available discount codes for a shop
 * GET /api/shopify/discounts
 */
export async function getShopifyDiscounts(req, res, next) {
  try {
    const shopDomain = req.ctx?.store?.shopDomain;
    if (!shopDomain) {
      throw new ValidationError(
        'Store context is required. Please ensure you are properly authenticated.',
      );
    }

    let discountCodes;
    try {
      discountCodes = await getDiscountCodes(shopDomain);
    } catch (shopifyError) {
      logger.error('Shopify API error in getShopifyDiscounts', {
        shopDomain,
        error: shopifyError.message,
        stack: shopifyError.stack,
        operation: 'getShopifyDiscounts',
      });

      // In development, return 5xx error to catch issues early
      // In production, return empty array to prevent breaking the UI
      const isDevelopment = process.env.NODE_ENV !== 'production';
      if (isDevelopment) {
        return res.status(500).json({
          success: false,
          error: 'Failed to fetch discounts from Shopify',
          message: shopifyError.message,
          shopDomain,
        });
      }

      // Production: return empty array to prevent breaking the UI
      discountCodes = [];
    }

    // Ensure discountCodes is an array
    if (!Array.isArray(discountCodes)) {
      logger.warn('getDiscountCodes returned non-array', {
        shopDomain,
        type: typeof discountCodes,
      });
      discountCodes = [];
    }

    // Filter only active and non-expired discounts
    const activeDiscounts = discountCodes.filter(
      discount => discount && discount.isActive && !discount.isExpired,
    );

    logger.info('Shopify discounts retrieved', {
      shopDomain,
      total: discountCodes.length,
      active: activeDiscounts.length,
    });

    return sendSuccess(res, {
      discounts: activeDiscounts,
      total: discountCodes.length,
      active: activeDiscounts.length,
    });
  } catch (error) {
    logger.error('Error in getShopifyDiscounts', {
      shopDomain: req.ctx?.store?.shopDomain || 'unknown',
      error: error.message,
      stack: error.stack,
    });
    next(error);
  }
}

/**
 * Get a specific discount code by ID
 * GET /api/shopify/discounts/:id
 */
export async function getShopifyDiscount(req, res, next) {
  try {
    const { id } = req.params;
    const shopDomain = req.ctx?.store?.shopDomain;
    if (!shopDomain) {
      throw new ValidationError(
        'Store context is required. Please ensure you are properly authenticated.',
      );
    }

    if (!id) {
      throw new ValidationError('Discount ID is required');
    }

    let discount;
    try {
      discount = await getDiscountCode(shopDomain, id);
    } catch (shopifyError) {
      logger.error('Shopify API error in getShopifyDiscount', {
        shopDomain,
        discountId: id,
        error: shopifyError.message,
        stack: shopifyError.stack,
      });
      throw new ValidationError(
        `Failed to retrieve discount: ${shopifyError.message}`,
      );
    }

    if (!discount) {
      throw new ValidationError('Discount not found');
    }

    logger.info('Shopify discount retrieved', {
      shopDomain,
      discountId: id,
      title: discount.title || 'Unknown',
    });

    return sendSuccess(res, discount);
  } catch (error) {
    logger.error('Error in getShopifyDiscount', {
      shopDomain: req.ctx?.store?.shopDomain || 'unknown',
      discountId: req.params.id,
      error: error.message,
      stack: error.stack,
    });
    next(error);
  }
}

/**
 * Validate discount code for campaign use
 * POST /api/shopify/discounts/validate
 */
export async function validateDiscount(req, res, next) {
  try {
    const { discountId } = req.body;
    const shopDomain = req.ctx?.store?.shopDomain;
    if (!shopDomain) {
      throw new ValidationError('Store context is required');
    }

    if (!discountId) {
      throw new ValidationError('Discount ID is required');
    }

    const discount = await getDiscountCode(shopDomain, discountId);

    // Check if discount is valid for campaign use
    const isValid = discount.isActive && !discount.isExpired;
    const canUse = isValid && discount.status === 'ACTIVE';

    logger.info('Discount validation', {
      shopDomain,
      discountId,
      isValid,
      canUse,
      status: discount.status,
    });

    return sendSuccess(res, {
      discount,
      isValid,
      canUse,
      reason: !isValid
        ? 'Discount is not active or has expired'
        : !canUse
          ? 'Discount is not available for use'
          : null,
    });
  } catch (error) {
    logger.error('Error in validateDiscount', {
      shopDomain: req.ctx?.store?.shopDomain || 'unknown',
      discountId: req.body.discountId,
      error: error.message,
    });
    next(error);
  }
}
