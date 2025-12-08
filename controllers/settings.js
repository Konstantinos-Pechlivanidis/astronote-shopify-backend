import prisma from '../services/prisma.js';
import { logger } from '../utils/logger.js';
import { getStoreId } from '../middlewares/store-resolution.js';
import { sendSuccess } from '../utils/response.js';
import { ValidationError, NotFoundError } from '../utils/errors.js';
import * as settingsService from '../services/settings.js';

/**
 * Get current user settings
 */
export async function getSettings(req, res, next) {
  try {
    const shopId = getStoreId(req);

    // Get shop with settings and recent transactions
    const shop = await prisma.shop.findUnique({
      where: { id: shopId },
      include: {
        settings: true,
        billingTransactions: {
          orderBy: { createdAt: 'desc' },
          take: 5,
          select: {
            id: true,
            creditsAdded: true,
            amount: true,
            currency: true,
            packageType: true,
            status: true,
            createdAt: true,
          },
        },
      },
    });

    if (!shop) {
      throw new NotFoundError('Shop');
    }

    // Usage guide content
    const usageGuide = {
      title: 'How Astronote Works',
      sections: [
        {
          title: 'SMS Credits',
          content:
            'Each SMS message costs 1 credit. Credits are deducted automatically when messages are sent successfully.',
        },
        {
          title: 'Purchasing Credits',
          content:
            'You can purchase credit packages through our secure Stripe checkout. Credits are added to your account immediately after payment.',
        },
        {
          title: 'Sender Number',
          content:
            'Set your sender number or name to personalize your SMS messages. This will be used for all campaigns and automations.',
        },
        {
          title: 'Support',
          content:
            'Need help? Visit our support center or contact us at support@astronote.com',
        },
      ],
    };

    // Return flat structure for easier frontend access
    // Frontend expects: senderId (senderNumber or senderName), timezone, currency, etc.
    const settings = shop.settings || {};

    return sendSuccess(res, {
      // Shop info
      shopId: shop.id,
      shopDomain: shop.shopDomain,
      shopName: shop.shopName,
      credits: shop.credits,
      createdAt: shop.createdAt,
      updatedAt: shop.updatedAt,
      // Settings (flat structure)
      senderId: settings.senderNumber || settings.senderName || '', // Frontend uses senderId
      senderNumber: settings.senderNumber || null,
      senderName: settings.senderName || null,
      timezone: settings.timezone || 'UTC',
      currency: settings.currency || shop.currency || 'EUR',
      // Additional data
      recentTransactions: shop.billingTransactions,
      usageGuide,
    });
  } catch (error) {
    logger.error('Failed to fetch settings', {
      error: error.message,
      stack: error.stack,
      shopId: getStoreId(req),
      requestId: req.id,
      path: req.path,
      method: req.method,
    });
    next(error);
  }
}

/**
 * Update sender number
 */
export async function updateSenderNumber(req, res, next) {
  try {
    const { senderNumber } = req.body;
    const shopId = getStoreId(req);

    // Validate sender number format
    if (!senderNumber || typeof senderNumber !== 'string') {
      throw new ValidationError(
        'Sender number is required and must be a string',
      );
    }

    // Validate format: E.164 for phone numbers or 3-11 alphanumeric for names
    const isE164 = /^\+[1-9]\d{1,14}$/.test(senderNumber);
    const isAlphanumeric = /^[a-zA-Z0-9]{3,11}$/.test(senderNumber);

    if (!isE164 && !isAlphanumeric) {
      throw new ValidationError(
        'Sender number must be either a valid E.164 phone number (e.g., +1234567890) or 3-11 alphanumeric characters',
      );
    }

    // Update or create shop settings
    const settings = await prisma.shopSettings.upsert({
      where: { shopId },
      update: { senderNumber },
      create: {
        shopId,
        senderNumber,
        timezone: 'UTC',
        currency: 'EUR',
      },
    });

    logger.info('Sender number updated', {
      shopId,
      senderNumber,
    });

    return sendSuccess(
      res,
      {
        senderNumber: settings.senderNumber,
        updatedAt: settings.updatedAt,
      },
      'Sender number updated successfully',
    );
  } catch (error) {
    logger.error('Failed to update sender number', {
      error: error.message,
      stack: error.stack,
      shopId: getStoreId(req),
      senderNumber: req.body.senderNumber,
      requestId: req.id,
      path: req.path,
      method: req.method,
    });
    next(error);
  }
}

/**
 * Get account information
 */
export async function getAccountInfo(req, res, next) {
  try {
    const shopId = getStoreId(req);

    const shop = await prisma.shop.findUnique({
      where: { id: shopId },
      include: {
        settings: true,
        _count: {
          select: {
            contacts: true,
            campaigns: true,
            automations: true,
            messages: true,
          },
        },
      },
    });

    if (!shop) {
      throw new NotFoundError('Shop');
    }

    // Calculate usage statistics
    const totalMessages = await prisma.messageLog.count({
      where: {
        shopId,
        direction: 'outbound',
        status: 'sent',
      },
    });

    const totalSpent = await prisma.billingTransaction.aggregate({
      where: {
        shopId,
        status: 'completed',
      },
      _sum: {
        amount: true,
      },
    });

    return sendSuccess(res, {
      shopDomain: shop.shopDomain,
      shopName: shop.shopName || shop.shopDomain.replace('.myshopify.com', ''),
      credits: shop.credits,
      account: {
        shopDomain: shop.shopDomain,
        credits: shop.credits,
        createdAt: shop.createdAt,
        senderNumber: shop.settings?.senderNumber,
        senderName: shop.settings?.senderName,
      },
      usage: {
        totalContacts: shop._count.contacts,
        totalCampaigns: shop._count.campaigns,
        totalAutomations: shop._count.automations,
        totalMessages,
        totalSpent: totalSpent._sum.amount || 0,
      },
    });
  } catch (error) {
    logger.error('Failed to fetch account information', {
      error: error.message,
      stack: error.stack,
      shopId: getStoreId(req),
      requestId: req.id,
      path: req.path,
      method: req.method,
    });
    next(error);
  }
}

/**
 * Update settings
 */
export async function updateSettings(req, res, next) {
  try {
    const shopId = getStoreId(req);
    const settingsData = req.body;

    // Prepare update data - map frontend fields to backend fields
    const updateData = {};

    // Handle senderId - can be either senderNumber or senderName
    if (settingsData.senderId !== undefined) {
      const senderId = settingsData.senderId?.trim() || '';
      if (senderId) {
        // Determine if it's a phone number (E.164) or alphanumeric name
        const isE164 = /^\+[1-9]\d{1,14}$/.test(senderId);
        if (isE164) {
          updateData.senderNumber = senderId;
          updateData.senderName = null; // Clear senderName if setting number
        } else if (/^[a-zA-Z0-9]{3,11}$/.test(senderId)) {
          updateData.senderName = senderId;
          updateData.senderNumber = null; // Clear senderNumber if setting name
        } else {
          throw new ValidationError(
            'Sender ID must be either a valid E.164 phone number (e.g., +1234567890) or 3-11 alphanumeric characters',
          );
        }
      } else {
        // Clear both if empty
        updateData.senderNumber = null;
        updateData.senderName = null;
      }
    }

    if (settingsData.timezone !== undefined) {
      updateData.timezone = settingsData.timezone;
    }

    if (settingsData.currency !== undefined) {
      // Validate currency - only EUR or USD allowed
      const validCurrencies = ['EUR', 'USD'];
      const normalizedCurrency = settingsData.currency.toUpperCase();
      if (!validCurrencies.includes(normalizedCurrency)) {
        throw new ValidationError('Currency must be EUR or USD');
      }
      updateData.currency = normalizedCurrency;
    }

    // Update settings
    const updatedSettings = await settingsService.updateSettings(
      shopId,
      updateData,
    );

    logger.info('Settings updated', {
      shopId,
      fields: Object.keys(updateData),
    });

    // Return in same format as getSettings
    return sendSuccess(
      res,
      {
        senderId:
          updatedSettings.senderNumber || updatedSettings.senderName || '',
        senderNumber: updatedSettings.senderNumber || null,
        senderName: updatedSettings.senderName || null,
        timezone: updatedSettings.timezone || 'UTC',
        currency: updatedSettings.currency || 'EUR',
        updatedAt: updatedSettings.updatedAt,
      },
      'Settings updated successfully',
    );
  } catch (error) {
    logger.error('Failed to update settings', {
      error: error.message,
      stack: error.stack,
      shopId: getStoreId(req),
      body: req.body,
      requestId: req.id,
      path: req.path,
      method: req.method,
    });
    next(error);
  }
}

export default {
  getSettings,
  updateSenderNumber,
  updateSettings,
  getAccountInfo,
};
