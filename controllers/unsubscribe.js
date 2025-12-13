import { logger } from '../utils/logger.js';
import { sendSuccess } from '../utils/response.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';
import { verifyUnsubscribeToken } from '../utils/unsubscribe.js';
import prisma from '../services/prisma.js';
import contactsService from '../services/contacts.js';

/**
 * Get unsubscribe page data (verify token and get contact/store info)
 * @route GET /api/unsubscribe/:token
 */
export async function getUnsubscribeInfo(req, res, next) {
  try {
    const { token } = req.params;

    if (!token) {
      throw new ValidationError('Unsubscribe token is required');
    }

    // Verify token
    const payload = verifyUnsubscribeToken(token);

    if (!payload) {
      throw new ValidationError('Invalid or expired unsubscribe token');
    }

    const { contactId, shopId, phoneE164 } = payload;

    // Get contact and shop info
    const [contact, shop] = await Promise.all([
      prisma.contact.findFirst({
        where: {
          id: contactId,
          shopId,
          phoneE164,
        },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          phoneE164: true,
          smsConsent: true,
        },
      }),
      prisma.shop.findUnique({
        where: { id: shopId },
        select: {
          id: true,
          shopName: true,
          shopDomain: true,
        },
      }),
    ]);

    if (!contact) {
      throw new NotFoundError('Contact');
    }

    if (!shop) {
      throw new NotFoundError('Shop');
    }

    logger.info('Unsubscribe info retrieved', {
      contactId,
      shopId,
      phoneE164: `${phoneE164.substring(0, 5)}***`,
    });

    // Track click event (non-blocking)
    try {
      // Find recent campaigns that sent to this contact (last 30 days)
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const recentRecipients = await prisma.campaignRecipient.findMany({
        where: {
          contactId,
          phoneE164,
          status: 'sent',
          sentAt: { gte: thirtyDaysAgo },
        },
        select: {
          id: true,
          campaignId: true,
        },
        take: 10, // Limit to most recent 10 campaigns
      });

      // Create click events for each campaign (avoid duplicates)
      if (recentRecipients.length > 0) {
        const clickEvents = recentRecipients.map(recipient => ({
          campaignId: recipient.campaignId,
          recipientId: recipient.id,
          contactId,
          phoneE164,
          linkType: 'unsubscribe',
          ipAddress: req.ip || req.headers['x-forwarded-for'] || null,
          userAgent: req.headers['user-agent'] || null,
        }));

        // Use createMany with skipDuplicates to avoid duplicate clicks
        await prisma.clickEvent.createMany({
          data: clickEvents,
          skipDuplicates: true, // Skip if same campaign+recipient+linkType already exists
        });

        // Update campaign metrics (increment totalClicked)
        const campaignIds = [...new Set(recentRecipients.map(r => r.campaignId))];
        await prisma.campaignMetrics.updateMany({
          where: {
            campaignId: { in: campaignIds },
          },
          data: {
            totalClicked: { increment: 1 },
          },
        });

        logger.debug('Click events tracked', {
          contactId,
          campaignCount: campaignIds.length,
          clickEventsCount: clickEvents.length,
        });
      }
    } catch (clickError) {
      // Don't fail the request if click tracking fails
      logger.warn('Failed to track click event', {
        error: clickError.message,
        contactId,
      });
    }

    return sendSuccess(res, {
      contact: {
        id: contact.id,
        firstName: contact.firstName,
        lastName: contact.lastName,
        phoneE164: contact.phoneE164,
        smsConsent: contact.smsConsent,
      },
      shop: {
        id: shop.id,
        shopName:
          shop.shopName || shop.shopDomain.replace('.myshopify.com', ''),
        shopDomain: shop.shopDomain,
      },
      token,
    });
  } catch (error) {
    logger.error('Get unsubscribe info error', {
      error: error.message,
      stack: error.stack,
      token: `${req.params.token?.substring(0, 20)}...`,
      requestId: req.id,
      path: req.path,
      method: req.method,
    });
    next(error);
  }
}

/**
 * Process unsubscribe request
 * @route POST /api/unsubscribe/:token
 */
export async function processUnsubscribe(req, res, next) {
  try {
    const { token } = req.params;

    if (!token) {
      throw new ValidationError('Unsubscribe token is required');
    }

    // Verify token
    const payload = verifyUnsubscribeToken(token);

    if (!payload) {
      throw new ValidationError('Invalid or expired unsubscribe token');
    }

    const { contactId, shopId, phoneE164 } = payload;

    // Verify contact exists and matches token
    const contact = await prisma.contact.findFirst({
      where: {
        id: contactId,
        shopId,
        phoneE164,
      },
    });

    if (!contact) {
      throw new NotFoundError('Contact');
    }

    // Update contact SMS consent to opted_out
    await contactsService.updateContact(shopId, contactId, {
      smsConsent: 'opted_out',
    });

    logger.info('Contact unsubscribed successfully', {
      contactId,
      shopId,
      phoneE164: `${phoneE164.substring(0, 5)}***`,
    });

    return sendSuccess(res, {
      success: true,
      message: 'You have been successfully unsubscribed from SMS messages.',
      contact: {
        id: contact.id,
        phoneE164: contact.phoneE164,
        smsConsent: 'opted_out',
      },
    });
  } catch (error) {
    logger.error('Process unsubscribe error', {
      error: error.message,
      stack: error.stack,
      token: `${req.params.token?.substring(0, 20)}...`,
      requestId: req.id,
      path: req.path,
      method: req.method,
    });
    next(error);
  }
}

export default {
  getUnsubscribeInfo,
  processUnsubscribe,
};
