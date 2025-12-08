import { logger } from '../utils/logger.js';
import prisma from '../services/prisma.js';
import { sendSuccess } from '../utils/response.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';
import { automationQueue } from '../queue/index.js';

/**
 * Handle Shopify order creation webhook
 */
export async function handleOrderCreated(req, res, _next) {
  try {
    const { shop_domain, id, customer, line_items } = req.body;

    if (!shop_domain || !id || !customer) {
      throw new ValidationError('shop_domain, id, and customer are required');
    }

    // Find the shop
    const shop = await prisma.shop.findUnique({
      where: { shopDomain: shop_domain },
    });

    if (!shop) {
      logger.warn('Shop not found for order webhook', { shop_domain });
      throw new NotFoundError('Shop');
    }

    // Find or create the customer contact
    let contact = await prisma.contact.findFirst({
      where: {
        shopId: shop.id,
        email: customer.email,
      },
    });

    // If contact doesn't exist, create it from Shopify customer data
    if (!contact) {
      logger.info('Contact not found, creating from Shopify customer data', {
        shopId: shop.id,
        customerEmail: customer.email,
      });

      // Extract phone number from customer data
      const phoneE164 =
        customer.phone || customer.default_address?.phone || null;

      contact = await prisma.contact.create({
        data: {
          shopId: shop.id,
          email: customer.email,
          firstName: customer.first_name || null,
          lastName: customer.last_name || null,
          phoneE164,
          smsConsent: 'unknown', // Default to unknown, user must opt-in
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });

      logger.info('Contact created from Shopify webhook', {
        contactId: contact.id,
        shopId: shop.id,
        email: customer.email,
      });
    }

    // Queue automation job instead of processing synchronously
    // This allows for retry on failure and doesn't block webhook response
    try {
      await automationQueue.add(
        'order-confirmation',
        {
          shopId: shop.id,
          contactId: contact.id,
          orderData: {
            orderNumber: id.toString(),
            customerEmail: customer.email,
            customerName:
              `${customer.first_name || ''} ${customer.last_name || ''}`.trim(),
            lineItems: line_items,
            totalPrice: req.body.total_price,
            currency: req.body.currency,
          },
        },
        {
          jobId: `order-confirmation-${shop.id}-${id}-${Date.now()}`,
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 2000,
          },
        },
      );

      logger.info('Order confirmation automation queued', {
        shopId: shop.id,
        contactId: contact.id,
        orderId: id,
      });

      // Return success immediately - job will be processed asynchronously
      return sendSuccess(
        res,
        { automationQueued: true },
        'Order webhook processed',
      );
    } catch (queueError) {
      logger.error('Failed to queue order confirmation automation', {
        shopId: shop.id,
        contactId: contact.id,
        orderId: id,
        error: queueError.message,
      });
      // Still return success to Shopify to prevent retries
      // The error is logged and can be handled separately
      return sendSuccess(
        res,
        { automationQueued: false, error: 'Queue failed' },
        'Order webhook processed',
      );
    }
  } catch (error) {
    logger.error('Order webhook processing failed', {
      error: error.message,
      body: req.body,
    });
    throw error;
  }
}

/**
 * Handle abandoned cart webhook (if available from Shopify)
 */
export async function handleCartAbandoned(req, res, _next) {
  try {
    const { shop_domain, customer, cart_token, line_items } = req.body;

    if (!shop_domain || !customer) {
      throw new ValidationError('shop_domain and customer are required');
    }

    // Find the shop
    const shop = await prisma.shop.findUnique({
      where: { shopDomain: shop_domain },
    });

    if (!shop) {
      logger.warn('Shop not found for cart webhook', { shop_domain });
      throw new NotFoundError('Shop');
    }

    // Find the customer contact
    const contact = await prisma.contact.findFirst({
      where: {
        shopId: shop.id,
        email: customer.email,
      },
    });

    if (!contact) {
      logger.warn('Contact not found for cart webhook', {
        shopId: shop.id,
        customerEmail: customer.email,
      });
      throw new NotFoundError('Contact');
    }

    // Queue automation job instead of processing synchronously
    try {
      await automationQueue.add(
        'abandoned-cart',
        {
          shopId: shop.id,
          contactId: contact.id,
          cartData: {
            cartToken: cart_token,
            customerEmail: customer.email,
            customerName:
              `${customer.first_name || ''} ${customer.last_name || ''}`.trim(),
            lineItems: line_items,
            abandonedAt: new Date().toISOString(),
          },
        },
        {
          jobId: `abandoned-cart-${shop.id}-${cart_token}-${Date.now()}`,
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 2000,
          },
        },
      );

      logger.info('Abandoned cart automation queued', {
        shopId: shop.id,
        contactId: contact.id,
        cartToken: cart_token,
      });

      return sendSuccess(
        res,
        { automationQueued: true },
        'Cart webhook processed',
      );
    } catch (queueError) {
      logger.error('Failed to queue abandoned cart automation', {
        shopId: shop.id,
        contactId: contact.id,
        cartToken: cart_token,
        error: queueError.message,
      });
      return sendSuccess(
        res,
        { automationQueued: false, error: 'Queue failed' },
        'Cart webhook processed',
      );
    }
  } catch (error) {
    logger.error('Cart webhook processing failed', {
      error: error.message,
      body: req.body,
    });
    throw error;
  }
}

/**
 * Manual trigger for testing automations
 */
export async function triggerAutomationManually(req, res, _next) {
  try {
    const { shopId, contactId, triggerEvent, additionalData = {} } = req.body;

    if (!shopId || !contactId || !triggerEvent) {
      throw new ValidationError(
        'shopId, contactId, and triggerEvent are required',
      );
    }

    // Import the automation service
    const { triggerAutomation } = await import('../services/automations.js');

    const result = await triggerAutomation({
      shopId,
      contactId,
      triggerEvent,
      additionalData,
    });

    if (result.success) {
      logger.info('Manual automation trigger successful', {
        shopId,
        contactId,
        triggerEvent,
        messageId: result.messageId,
      });

      return sendSuccess(res, result, 'Automation triggered successfully');
    } else {
      logger.warn('Manual automation trigger failed', {
        shopId,
        contactId,
        triggerEvent,
        reason: result.reason,
      });

      throw new ValidationError(result.reason || 'Automation trigger failed');
    }
  } catch (error) {
    logger.error('Manual automation trigger failed', {
      error: error.message,
      body: req.body,
    });
    throw error;
  }
}

/**
 * Handle Shopify order fulfillment webhook
 */
export async function handleOrderFulfilled(req, res, _next) {
  try {
    const {
      shop_domain,
      id,
      customer,
      fulfillment_status,
      tracking_number,
      tracking_urls,
    } = req.body;

    if (!shop_domain || !id || !customer) {
      throw new ValidationError('shop_domain, id, and customer are required');
    }

    // Find the shop
    const shop = await prisma.shop.findUnique({
      where: { shopDomain: shop_domain },
    });

    if (!shop) {
      logger.warn('Shop not found for order fulfillment webhook', {
        shop_domain,
      });
      throw new NotFoundError('Shop');
    }

    // Find or create the customer contact
    let contact = await prisma.contact.findFirst({
      where: {
        shopId: shop.id,
        email: customer.email,
      },
    });

    // If contact doesn't exist, create it from Shopify customer data
    if (!contact) {
      logger.info('Contact not found, creating from Shopify customer data', {
        shopId: shop.id,
        customerEmail: customer.email,
      });

      const phoneE164 =
        customer.phone || customer.default_address?.phone || null;

      contact = await prisma.contact.create({
        data: {
          shopId: shop.id,
          email: customer.email,
          firstName: customer.first_name || null,
          lastName: customer.last_name || null,
          phoneE164,
          smsConsent: 'unknown',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });

      logger.info('Contact created from Shopify webhook', {
        contactId: contact.id,
        shopId: shop.id,
        email: customer.email,
      });
    }

    // Queue automation job
    try {
      await automationQueue.add(
        'order-fulfilled',
        {
          shopId: shop.id,
          contactId: contact.id,
          orderData: {
            orderNumber: id.toString(),
            customerEmail: customer.email,
            customerName:
              `${customer.first_name || ''} ${customer.last_name || ''}`.trim(),
            fulfillmentStatus: fulfillment_status,
            trackingNumber: tracking_number,
            trackingUrls: tracking_urls || [],
          },
        },
        {
          jobId: `order-fulfilled-${shop.id}-${id}-${Date.now()}`,
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 2000,
          },
        },
      );

      logger.info('Order fulfillment automation queued', {
        shopId: shop.id,
        contactId: contact.id,
        orderId: id,
      });

      return sendSuccess(
        res,
        { automationQueued: true },
        'Order fulfillment webhook processed',
      );
    } catch (queueError) {
      logger.error('Failed to queue order fulfillment automation', {
        shopId: shop.id,
        contactId: contact.id,
        orderId: id,
        error: queueError.message,
      });
      return sendSuccess(
        res,
        { automationQueued: false, error: 'Queue failed' },
        'Order fulfillment webhook processed',
      );
    }
  } catch (error) {
    logger.error('Order fulfillment webhook processing failed', {
      error: error.message,
      body: req.body,
    });
    throw error;
  }
}

export default {
  handleOrderCreated,
  handleOrderFulfilled,
  handleCartAbandoned,
  triggerAutomationManually,
};
