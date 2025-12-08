import prisma from './prisma.js';
import { sendSms } from './mitto.js';
import { logger } from '../utils/logger.js';

/**
 * Trigger an automation for a specific contact
 */
export async function triggerAutomation({
  shopId,
  contactId,
  triggerEvent,
  additionalData = {},
}) {
  try {
    // Find the user automation for this trigger (system default or custom)
    const userAutomation = await prisma.userAutomation.findFirst({
      where: {
        shopId,
        automation: {
          triggerEvent,
        },
        isActive: true,
      },
      include: {
        automation: true,
        shop: {
          include: {
            settings: true,
          },
        },
      },
    });

    if (!userAutomation) {
      logger.warn('No active automation found for trigger', {
        shopId,
        triggerEvent,
      });
      return { success: false, reason: 'No active automation found' };
    }

    // Get contact information
    const contact = await prisma.contact.findUnique({
      where: { id: contactId },
    });

    if (!contact) {
      logger.warn('Contact not found for automation trigger', {
        contactId,
        shopId,
        triggerEvent,
      });
      return { success: false, reason: 'Contact not found' };
    }

    // Check if contact has SMS consent
    if (contact.smsConsent !== 'opted_in') {
      logger.warn('Contact does not have SMS consent', {
        contactId,
        shopId,
        triggerEvent,
        smsConsent: contact.smsConsent,
      });
      return { success: false, reason: 'No SMS consent' };
    }

    // Prepare message content
    const messageContent =
      userAutomation.userMessage || userAutomation.automation.defaultMessage;

    // Replace template variables
    const processedMessage = processMessageTemplate(messageContent, {
      contact,
      shop: userAutomation.shop,
      ...additionalData,
    });

    // Get sender information
    const senderNumber =
      userAutomation.shop.settings?.senderNumber ||
      userAutomation.shop.settings?.senderName ||
      process.env.MITTO_SENDER_NAME ||
      'Astronote';

    // Send SMS
    const smsResult = await sendSms({
      to: contact.phoneE164,
      text: processedMessage,
      senderOverride: senderNumber,
      shopId,
    });

    // sendSms returns {messageId, status} on success, throws error on failure
    if (smsResult && smsResult.messageId) {
      // Log the automation trigger
      await prisma.messageLog.create({
        data: {
          shopId,
          phoneE164: contact.phoneE164,
          direction: 'outbound',
          provider: 'mitto',
          providerMsgId: smsResult.messageId,
          status: 'sent',
          campaignId: null, // Automation, not campaign
        },
      });

      logger.info('Automation triggered successfully', {
        shopId,
        contactId,
        triggerEvent,
        messageId: smsResult.messageId,
        automationId: userAutomation.automationId,
      });

      return {
        success: true,
        messageId: smsResult.messageId,
        automationId: userAutomation.automationId,
      };
    } else {
      logger.error('Failed to send automation SMS - unexpected result', {
        shopId,
        contactId,
        triggerEvent,
        result: smsResult,
      });

      return {
        success: false,
        reason: 'SMS sending failed - unexpected result',
      };
    }
  } catch (error) {
    logger.error('Automation trigger failed', {
      error: error.message,
      shopId,
      contactId,
      triggerEvent,
    });

    return {
      success: false,
      reason: 'Internal error',
      error: error.message,
    };
  }
}

/**
 * Process message template with variables
 */
function processMessageTemplate(template, data) {
  let processedMessage = template;

  // Replace contact variables
  if (data.contact) {
    processedMessage = processedMessage.replace(
      /\{\{firstName\}\}/g,
      data.contact.firstName || '',
    );
    processedMessage = processedMessage.replace(
      /\{\{lastName\}\}/g,
      data.contact.lastName || '',
    );
    processedMessage = processedMessage.replace(
      /\{\{phone\}\}/g,
      data.contact.phoneE164 || '',
    );
  }

  // Replace shop variables
  if (data.shop) {
    processedMessage = processedMessage.replace(
      /\{\{shopName\}\}/g,
      data.shop.shopDomain || '',
    );
    processedMessage = processedMessage.replace(
      /\{\{shopDomain\}\}/g,
      data.shop.shopDomain || '',
    );
  }

  // Replace additional data variables
  if (data.orderNumber) {
    processedMessage = processedMessage.replace(
      /\{\{orderNumber\}\}/g,
      data.orderNumber,
    );
  }
  if (data.trackingLink) {
    processedMessage = processedMessage.replace(
      /\{\{trackingLink\}\}/g,
      data.trackingLink,
    );
  }
  if (data.trackingNumber) {
    processedMessage = processedMessage.replace(
      /\{\{trackingNumber\}\}/g,
      data.trackingNumber,
    );
  }
  if (
    data.trackingUrls &&
    Array.isArray(data.trackingUrls) &&
    data.trackingUrls.length > 0
  ) {
    // Use first tracking URL if available
    processedMessage = processedMessage.replace(
      /\{\{trackingLink\}\}/g,
      data.trackingUrls[0],
    );
  }
  if (data.productName) {
    processedMessage = processedMessage.replace(
      /\{\{productName\}\}/g,
      data.productName,
    );
  }
  if (data.discountCode) {
    processedMessage = processedMessage.replace(
      /\{\{discountCode\}\}/g,
      data.discountCode,
    );
  }

  return processedMessage;
}

/**
 * Trigger abandoned cart automation
 */
export async function triggerAbandonedCart({
  shopId,
  contactId,
  cartData = {},
}) {
  return await triggerAutomation({
    shopId,
    contactId,
    triggerEvent: 'cart_abandoned',
    additionalData: cartData,
  });
}

/**
 * Trigger order confirmation automation
 */
export async function triggerOrderConfirmation({
  shopId,
  contactId,
  orderData = {},
}) {
  return await triggerAutomation({
    shopId,
    contactId,
    triggerEvent: 'order_placed',
    additionalData: orderData,
  });
}

/**
 * Trigger order fulfillment automation
 */
export async function triggerOrderFulfilled({
  shopId,
  contactId,
  orderData = {},
}) {
  return await triggerAutomation({
    shopId,
    contactId,
    triggerEvent: 'order_fulfilled',
    additionalData: orderData,
  });
}

/**
 * Trigger customer re-engagement automation
 */
export async function triggerCustomerReengagement({
  shopId,
  contactId,
  reengagementData = {},
}) {
  return await triggerAutomation({
    shopId,
    contactId,
    triggerEvent: 'customer_inactive',
    additionalData: reengagementData,
  });
}

/**
 * Trigger birthday automation
 */
export async function triggerBirthdayOffer({
  shopId,
  contactId,
  birthdayData = {},
}) {
  return await triggerAutomation({
    shopId,
    contactId,
    triggerEvent: 'birthday',
    additionalData: birthdayData,
  });
}

/**
 * Trigger welcome automation
 */
export async function triggerWelcome({ shopId, contactId, welcomeData = {} }) {
  return await triggerAutomation({
    shopId,
    contactId,
    triggerEvent: 'welcome',
    additionalData: welcomeData,
  });
}

/**
 * Get all active automations for a shop
 */
export async function getActiveAutomations(shopId) {
  return await prisma.userAutomation.findMany({
    where: {
      shopId,
      isActive: true,
    },
    include: {
      automation: true,
    },
  });
}

/**
 * Check if a shop has a specific automation active
 */
export async function hasActiveAutomation(shopId, triggerEvent) {
  const automation = await prisma.userAutomation.findFirst({
    where: {
      shopId,
      isActive: true,
      automation: {
        triggerEvent,
      },
    },
  });

  return !!automation;
}

/**
 * Daily Cron Job: Check for birthdays and trigger automation
 * Should be called once per day (e.g., at midnight)
 */
export async function processDailyBirthdayAutomations() {
  try {
    logger.info('Starting daily birthday automation check...');

    // Find all contacts with birthdays
    const contactsWithBirthdays = await prisma.contact.findMany({
      where: {
        birthDate: {
          not: null,
        },
        smsConsent: 'opted_in',
      },
      include: {
        shop: {
          include: {
            settings: true,
            userAutomations: {
              where: {
                isActive: true,
                automation: {
                  triggerEvent: 'birthday',
                },
              },
              include: {
                automation: true,
              },
            },
          },
        },
      },
    });

    // Filter contacts whose birthday is today in their shop's timezone
    const birthdayContacts = contactsWithBirthdays.filter(contact => {
      if (!contact.birthDate) return false;

      // Get shop timezone (default to UTC if not set)
      const shopTimezone = contact.shop.settings?.timezone || 'UTC';

      // Get today's date in shop timezone
      const todayInShopTimezone = new Date(
        new Date().toLocaleString('en-US', { timeZone: shopTimezone }),
      );
      const todayMonth = String(todayInShopTimezone.getMonth() + 1).padStart(
        2,
        '0',
      );
      const todayDay = String(todayInShopTimezone.getDate()).padStart(2, '0');

      // Get birthday date (stored as Date, extract month and day)
      const birthDate = new Date(contact.birthDate);
      const birthMonth = String(birthDate.getMonth() + 1).padStart(2, '0');
      const birthDay = String(birthDate.getDate()).padStart(2, '0');

      const isBirthdayToday =
        birthMonth === todayMonth && birthDay === todayDay;

      if (isBirthdayToday) {
        logger.debug('Contact has birthday today', {
          contactId: contact.id,
          shopId: contact.shopId,
          shopTimezone,
          birthDate: contact.birthDate,
          todayInShopTimezone: todayInShopTimezone.toISOString(),
        });
      }

      return isBirthdayToday;
    });

    logger.info(
      `Found ${birthdayContacts.length} contacts with birthday today`,
    );

    const results = {
      total: birthdayContacts.length,
      sent: 0,
      skipped: 0,
      failed: 0,
      details: [],
    };

    // Process each contact
    for (const contact of birthdayContacts) {
      try {
        // Check if shop has active birthday automation
        if (
          !contact.shop.userAutomations ||
          contact.shop.userAutomations.length === 0
        ) {
          logger.info('No active birthday automation for shop', {
            shopId: contact.shopId,
            contactId: contact.id,
          });
          results.skipped++;
          results.details.push({
            contactId: contact.id,
            shopId: contact.shopId,
            status: 'skipped',
            reason: 'No active birthday automation',
          });
          continue;
        }

        // Trigger birthday automation
        const result = await triggerBirthdayOffer({
          shopId: contact.shopId,
          contactId: contact.id,
          birthdayData: {
            firstName: contact.firstName,
            lastName: contact.lastName,
          },
        });

        if (result.success) {
          results.sent++;
          results.details.push({
            contactId: contact.id,
            shopId: contact.shopId,
            status: 'sent',
            messageId: result.messageId,
          });
          logger.info('Birthday SMS sent successfully', {
            contactId: contact.id,
            shopId: contact.shopId,
            messageId: result.messageId,
          });
        } else {
          results.failed++;
          results.details.push({
            contactId: contact.id,
            shopId: contact.shopId,
            status: 'failed',
            reason: result.reason,
          });
          logger.warn('Birthday SMS failed', {
            contactId: contact.id,
            shopId: contact.shopId,
            reason: result.reason,
          });
        }
      } catch (error) {
        results.failed++;
        results.details.push({
          contactId: contact.id,
          shopId: contact.shopId,
          status: 'failed',
          error: error.message,
        });
        logger.error('Error processing birthday automation', {
          contactId: contact.id,
          shopId: contact.shopId,
          error: error.message,
        });
      }
    }

    logger.info('Daily birthday automation check completed', results);
    return results;
  } catch (error) {
    logger.error('Failed to process daily birthday automations', {
      error: error.message,
      stack: error.stack,
    });
    throw error;
  }
}

export default {
  triggerAutomation,
  triggerAbandonedCart,
  triggerOrderConfirmation,
  triggerOrderFulfilled,
  triggerCustomerReengagement,
  triggerBirthdayOffer,
  triggerWelcome,
  getActiveAutomations,
  hasActiveAutomation,
  processDailyBirthdayAutomations,
  processMessageTemplate,
};
