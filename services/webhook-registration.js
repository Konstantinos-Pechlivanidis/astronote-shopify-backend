import { logger } from '../utils/logger.js';
import prisma from './prisma.js';

/**
 * Register Shopify webhooks for automation events
 * @param {string} shopDomain - Shop domain
 * @returns {Promise<Object>} Registration results
 */
export async function registerAutomationWebhooks(shopDomain) {
  try {
    const shop = await prisma.shop.findUnique({
      where: { shopDomain },
      select: { id: true, accessToken: true },
    });

    if (!shop || !shop.accessToken) {
      throw new Error('Shop access token not available');
    }

    const baseUrl =
      process.env.HOST ||
      process.env.WEBHOOK_BASE_URL ||
      'https://astronote-shopify-backend.onrender.com';
    const webhookBaseUrl = `${baseUrl}/automation-webhooks`;

    // Webhooks to register
    const webhooksToRegister = [
      {
        topic: 'orders/create',
        address: `${webhookBaseUrl}/shopify/orders/create`,
        format: 'json',
      },
      {
        topic: 'orders/fulfilled',
        address: `${webhookBaseUrl}/shopify/orders/fulfilled`,
        format: 'json',
      },
      {
        topic: 'customers/create',
        address: `${webhookBaseUrl}/shopify/customers/create`,
        format: 'json',
      },
    ];

    const results = [];
    const errors = [];

    // Register each webhook using Shopify REST Admin API
    for (const webhook of webhooksToRegister) {
      try {
        const response = await fetch(
          `https://${shopDomain}/admin/api/2024-04/webhooks.json`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Shopify-Access-Token': shop.accessToken,
            },
            body: JSON.stringify({
              webhook: {
                topic: webhook.topic,
                address: webhook.address,
                format: webhook.format,
              },
            }),
          },
        );

        if (!response.ok) {
          const errorText = await response.text();
          logger.warn('Failed to register webhook', {
            shopDomain,
            topic: webhook.topic,
            status: response.status,
            error: errorText,
          });
          errors.push({ topic: webhook.topic, error: errorText });
          continue;
        }

        const data = await response.json();
        const webhookData = data.webhook;

        // Store webhook ID in database for future management
        await prisma.shop.update({
          where: { shopDomain },
          data: {
            // Store webhook IDs in a JSON field or separate table
            // For now, just log them
          },
        });

        logger.info('Webhook registered successfully', {
          shopDomain,
          topic: webhook.topic,
          webhookId: webhookData.id,
          address: webhookData.address,
        });

        results.push({
          topic: webhook.topic,
          webhookId: webhookData.id,
          address: webhookData.address,
          status: 'registered',
        });
      } catch (error) {
        logger.error('Error registering webhook', {
          shopDomain,
          topic: webhook.topic,
          error: error.message,
        });
        errors.push({ topic: webhook.topic, error: error.message });
      }
    }

    return {
      success: errors.length === 0,
      registered: results,
      errors,
    };
  } catch (error) {
    logger.error('Failed to register automation webhooks', {
      shopDomain,
      error: error.message,
      stack: error.stack,
    });
    throw error;
  }
}

/**
 * List registered webhooks for a shop
 * @param {string} shopDomain - Shop domain
 * @returns {Promise<Array>} List of webhooks
 */
export async function listWebhooks(shopDomain) {
  try {
    const shop = await prisma.shop.findUnique({
      where: { shopDomain },
      select: { accessToken: true },
    });

    if (!shop || !shop.accessToken) {
      throw new Error('Shop access token not available');
    }

    const response = await fetch(
      `https://${shopDomain}/admin/api/2024-04/webhooks.json`,
      {
        method: 'GET',
        headers: {
          'X-Shopify-Access-Token': shop.accessToken,
        },
      },
    );

    if (!response.ok) {
      throw new Error(`Failed to list webhooks: ${response.status}`);
    }

    const data = await response.json();
    return data.webhooks || [];
  } catch (error) {
    logger.error('Failed to list webhooks', {
      shopDomain,
      error: error.message,
    });
    throw error;
  }
}

/**
 * Delete a webhook
 * @param {string} shopDomain - Shop domain
 * @param {string} webhookId - Webhook ID
 * @returns {Promise<void>}
 */
export async function deleteWebhook(shopDomain, webhookId) {
  try {
    const shop = await prisma.shop.findUnique({
      where: { shopDomain },
      select: { accessToken: true },
    });

    if (!shop || !shop.accessToken) {
      throw new Error('Shop access token not available');
    }

    const response = await fetch(
      `https://${shopDomain}/admin/api/2024-04/webhooks/${webhookId}.json`,
      {
        method: 'DELETE',
        headers: {
          'X-Shopify-Access-Token': shop.accessToken,
        },
      },
    );

    if (!response.ok) {
      throw new Error(`Failed to delete webhook: ${response.status}`);
    }

    logger.info('Webhook deleted', {
      shopDomain,
      webhookId,
    });
  } catch (error) {
    logger.error('Failed to delete webhook', {
      shopDomain,
      webhookId,
      error: error.message,
    });
    throw error;
  }
}

export default {
  registerAutomationWebhooks,
  listWebhooks,
  deleteWebhook,
};
