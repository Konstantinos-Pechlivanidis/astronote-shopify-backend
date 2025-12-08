import { logger } from '../utils/logger.js';
import { sendSuccess, sendError } from '../utils/response.js';
import { ValidationError, NotFoundError } from '../utils/errors.js';
import prisma from '../services/prisma.js';
import contactsService, {
  normalizePhone,
  isValidPhoneE164,
} from '../services/contacts.js';

/**
 * Public opt-in endpoint handler
 * Creates or updates a contact with SMS consent
 * @route POST /api/opt-in
 */
export async function handleOptIn(req, res, next) {
  try {
    const {
      phone,
      consent,
      shopDomain,
      firstName,
      lastName,
      birthday,
      gender,
      source = 'theme-banner',
    } = req.body;

    // Validate input
    if (!phone || !consent || !shopDomain) {
      throw new ValidationError('Phone, consent, and shopDomain are required');
    }

    // Validate phone format
    const phoneE164 = normalizePhone(phone);
    if (!isValidPhoneE164(phoneE164)) {
      throw new ValidationError(
        'Invalid phone number format. Use E.164 format (e.g., +306977123456)',
      );
    }

    // Validate shop domain format
    if (!shopDomain.match(/^[a-zA-Z0-9-]+\.myshopify\.com$/)) {
      throw new ValidationError('Invalid shop domain format');
    }

    // Find shop by domain
    const shop = await prisma.shop.findUnique({
      where: { shopDomain },
    });

    if (!shop) {
      logger.warn('Shop not found for opt-in', { shopDomain });
      throw new NotFoundError(
        'Shop not found. Please ensure the app is installed on this store.',
      );
    }

    // Validate required fields
    if (!firstName || !firstName.trim()) {
      throw new ValidationError('First name is required');
    }
    if (!lastName || !lastName.trim()) {
      throw new ValidationError('Last name is required');
    }
    if (!birthday || !birthday.trim()) {
      throw new ValidationError('Birthday is required');
    }
    // Validate birthday format
    if (!birthday.match(/^\d{4}-\d{2}-\d{2}$/)) {
      throw new ValidationError('Birthday must be in YYYY-MM-DD format');
    }

    // Prepare contact data
    const contactData = {
      phoneE164,
      smsConsent: 'opted_in',
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      gender: gender || null,
      birthDate: birthday.trim(), // Pass as string, createContact will handle Date conversion
      tags: source ? [`opt-in-${source}`] : [],
    };

    // Log contact data for debugging
    logger.info('Preparing contact data for opt-in', {
      shopId: shop.id,
      contactData: {
        phoneE164: contactData.phoneE164,
        firstName: contactData.firstName,
        lastName: contactData.lastName,
        gender: contactData.gender,
        birthDate: contactData.birthDate,
        smsConsent: contactData.smsConsent,
        tags: contactData.tags,
      },
    });

    // Check for existing contact by phone
    let contact = await prisma.contact.findFirst({
      where: {
        shopId: shop.id,
        phoneE164,
      },
    });

    if (contact) {
      // Update existing contact with SMS consent and new data
      // Always update with new data if provided, otherwise keep existing
      const updateData = {
        smsConsent: 'opted_in',
        updatedAt: new Date(),
      };

      // Update firstName if provided
      if (contactData.firstName && contactData.firstName.trim()) {
        updateData.firstName = contactData.firstName.trim();
      }

      // Update lastName if provided
      if (contactData.lastName && contactData.lastName.trim()) {
        updateData.lastName = contactData.lastName.trim();
      }

      // Update gender if provided
      if (contactData.gender) {
        updateData.gender = contactData.gender;
      }

      // Update birthDate if provided
      if (contactData.birthDate && contactData.birthDate.trim()) {
        const birthDate = new Date(contactData.birthDate);
        if (!isNaN(birthDate.getTime()) && birthDate <= new Date()) {
          updateData.birthDate = birthDate;
        }
      }

      logger.info('Updating existing contact via opt-in', {
        contactId: contact.id,
        shopId: shop.id,
        updateData,
      });

      contact = await prisma.contact.update({
        where: { id: contact.id },
        data: updateData,
      });

      logger.info('Contact updated with SMS consent via opt-in', {
        contactId: contact.id,
        shopId: shop.id,
        source,
      });
    } else {
      // Create new contact with SMS consent
      try {
        contact = await contactsService.createContact(shop.id, contactData);

        logger.info('Contact created via opt-in', {
          contactId: contact.id,
          shopId: shop.id,
          source,
        });
      } catch (error) {
        // If contact creation fails due to duplicate, try to find and update
        if (error.message && error.message.includes('already exists')) {
          contact = await prisma.contact.findFirst({
            where: {
              shopId: shop.id,
              phoneE164,
            },
          });

          if (contact) {
            // Update existing contact with new data
            const updateData = {
              smsConsent: 'opted_in',
              updatedAt: new Date(),
            };

            // Update firstName if provided
            if (contactData.firstName && contactData.firstName.trim()) {
              updateData.firstName = contactData.firstName.trim();
            }

            // Update lastName if provided
            if (contactData.lastName && contactData.lastName.trim()) {
              updateData.lastName = contactData.lastName.trim();
            }

            // Update gender if provided
            if (contactData.gender) {
              updateData.gender = contactData.gender;
            }

            // Update birthDate if provided
            if (contactData.birthDate && contactData.birthDate.trim()) {
              const birthDate = new Date(contactData.birthDate);
              if (!isNaN(birthDate.getTime()) && birthDate <= new Date()) {
                updateData.birthDate = birthDate;
              }
            }

            contact = await prisma.contact.update({
              where: { id: contact.id },
              data: updateData,
            });
          }
        } else {
          throw error;
        }
      }
    }

    return sendSuccess(
      res,
      {
        contactId: contact.id,
        phone: contact.phoneE164,
        smsConsent: contact.smsConsent,
        firstName: contact.firstName,
        lastName: contact.lastName,
        birthday: contact.birthDate
          ? contact.birthDate.toISOString().split('T')[0]
          : null,
        gender: contact.gender,
      },
      'Successfully opted in to SMS marketing',
    );
  } catch (error) {
    // Extract request ID from headers if available
    const requestId = req.headers['x-request-id'] || req.id || 'unknown';

    logger.error('Opt-in error', {
      error: error.message,
      stack: error.stack,
      body: req.body,
      requestId,
      path: req.path,
      method: req.method,
      clientPlatform: req.headers['x-client-platform'],
      clientVersion: req.headers['x-client-version'],
    });

    if (error instanceof ValidationError || error instanceof NotFoundError) {
      return sendError(res, error.message, 400);
    }

    next(error);
  }
}

export default {
  handleOptIn,
};
