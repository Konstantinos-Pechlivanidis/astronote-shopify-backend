import prisma from './prisma.js';
import { logger } from '../utils/logger.js';
import {
  ValidationError,
  NotFoundError,
  ConflictError,
} from '../utils/errors.js';
import { automationQueue } from '../queue/index.js';
import { hasActiveAutomation } from './automations.js';

/**
 * Contacts Service
 * Handles all contact-related business logic including CRUD operations,
 * validation, duplicate detection, and import/export functionality
 */

/**
 * Validate phone number format (E.164)
 * @param {string} phone - Phone number to validate
 * @returns {boolean} True if valid
 */
function isValidPhoneE164(phone) {
  if (!phone) return false;
  // E.164 format: +[country code][number] (max 15 digits)
  const e164Regex = /^\+[1-9]\d{1,14}$/;
  return e164Regex.test(phone);
}

/**
 * Validate email format
 * @param {string} email - Email to validate
 * @returns {boolean} True if valid
 */
function isValidEmail(email) {
  if (!email) return true; // Email is optional
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * Normalize phone number to E.164 format
 * @param {string} phone - Phone number to normalize
 * @returns {string} Normalized phone number
 */
function normalizePhone(phone) {
  if (!phone) return phone;
  // Remove all non-digit characters except +
  let normalized = phone.replace(/[^\d+]/g, '');
  // Ensure it starts with +
  if (!normalized.startsWith('+')) {
    normalized = `+${normalized}`;
  }
  return normalized;
}

/**
 * Check for duplicate contacts
 * @param {string} storeId - Store ID
 * @param {string} phoneE164 - Phone number
 * @param {string} email - Email address
 * @param {string} excludeId - Contact ID to exclude from check
 * @returns {Promise<Object>} Duplicate check result
 */
async function checkDuplicates(storeId, phoneE164, email, excludeId = null) {
  const where = {
    shopId: storeId,
    OR: [],
  };

  // Only add phone to OR if it's provided and not null
  if (phoneE164) {
    where.OR.push({ phoneE164 });
  }

  // Only add email to OR if it's provided and not null
  if (email) {
    where.OR.push({ email });
  }

  // If no OR conditions, return no duplicates
  if (where.OR.length === 0) {
    return {
      hasDuplicate: false,
      duplicate: null,
    };
  }

  if (excludeId) {
    where.id = { not: excludeId };
  }

  const duplicates = await prisma.contact.findFirst({
    where,
    select: { id: true, phoneE164: true, email: true },
  });

  return {
    hasDuplicate: !!duplicates,
    duplicate: duplicates,
  };
}

/**
 * List contacts with filtering, search, and pagination
 * @param {string} storeId - Store ID
 * @param {Object} filters - Filter options
 * @returns {Promise<Object>} Contacts list with pagination
 */
export async function listContacts(storeId, filters = {}) {
  const {
    page = 1,
    pageSize = 20,
    filter = 'all',
    q: searchTerm,
    sortBy = 'createdAt',
    sortOrder = 'desc',
    gender,
    smsConsent,
    hasBirthDate,
  } = filters;

  logger.info('Listing contacts', { storeId, filters });

  // Build where clause
  const where = { shopId: storeId };

  // Gender filter
  if (gender && ['male', 'female', 'other'].includes(gender)) {
    where.gender = gender;
  }

  // SMS consent filter
  if (smsConsent && ['opted_in', 'opted_out', 'unknown'].includes(smsConsent)) {
    where.smsConsent = smsConsent;
  }

  // Birth date filter
  if (hasBirthDate === 'true' || hasBirthDate === true) {
    where.birthDate = { not: null };
  } else if (hasBirthDate === 'false' || hasBirthDate === false) {
    where.birthDate = null;
  }

  // Legacy filter support
  if (filter === 'male') {
    where.gender = 'male';
  } else if (filter === 'female') {
    where.gender = 'female';
  } else if (filter === 'consented') {
    where.smsConsent = 'opted_in';
  } else if (filter === 'nonconsented') {
    where.smsConsent = { in: ['opted_out', 'unknown'] };
  }

  // Search functionality
  if (searchTerm) {
    where.OR = [
      { firstName: { contains: searchTerm, mode: 'insensitive' } },
      { lastName: { contains: searchTerm, mode: 'insensitive' } },
      { email: { contains: searchTerm, mode: 'insensitive' } },
      { phoneE164: { contains: searchTerm } },
      { tags: { hasSome: [searchTerm] } },
    ];
  }

  // Validate sort parameters
  const validSortFields = [
    'createdAt',
    'updatedAt',
    'firstName',
    'lastName',
    'birthDate',
  ];
  const sortField = validSortFields.includes(sortBy) ? sortBy : 'createdAt';
  const sortDirection = sortOrder === 'asc' ? 'asc' : 'desc';

  // Execute paginated query
  const [contacts, total] = await Promise.all([
    prisma.contact.findMany({
      where,
      orderBy: { [sortField]: sortDirection },
      take: parseInt(pageSize),
      skip: (parseInt(page) - 1) * parseInt(pageSize),
      select: {
        id: true,
        firstName: true,
        lastName: true,
        phoneE164: true,
        email: true,
        gender: true,
        birthDate: true,
        smsConsent: true,
        tags: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    prisma.contact.count({ where }),
  ]);

  // Calculate pagination metadata
  const totalPages = Math.ceil(total / parseInt(pageSize));

  logger.info('Contacts listed successfully', {
    storeId,
    total,
    page: parseInt(page),
    returned: contacts.length,
  });

  return {
    contacts,
    pagination: {
      page: parseInt(page),
      pageSize: parseInt(pageSize),
      total,
      totalPages,
      hasNextPage: parseInt(page) < totalPages,
      hasPrevPage: parseInt(page) > 1,
    },
  };
}

/**
 * Get contact by ID
 * @param {string} storeId - Store ID
 * @param {string} contactId - Contact ID
 * @returns {Promise<Object>} Contact data
 */
export async function getContactById(storeId, contactId) {
  logger.info('Getting contact by ID', { storeId, contactId });

  const contact = await prisma.contact.findFirst({
    where: {
      id: contactId,
      shopId: storeId,
    },
  });

  if (!contact) {
    throw new NotFoundError('Contact');
  }

  logger.info('Contact retrieved successfully', { storeId, contactId });

  return contact;
}

/**
 * Create new contact
 * @param {string} storeId - Store ID
 * @param {Object} contactData - Contact data
 * @returns {Promise<Object>} Created contact
 */
export async function createContact(storeId, contactData) {
  logger.info('Creating contact', { storeId, phone: contactData.phoneE164 });

  // Validate required fields
  if (!contactData.phoneE164) {
    throw new ValidationError('Phone number is required');
  }

  // Normalize phone number
  const phoneE164 = normalizePhone(contactData.phoneE164);

  // Validate phone format
  if (!isValidPhoneE164(phoneE164)) {
    throw new ValidationError(
      'Invalid phone number format. Use E.164 format (e.g., +306977123456)',
    );
  }

  // Validate email if provided
  if (
    contactData.email &&
    contactData.email.trim() &&
    !isValidEmail(contactData.email.trim())
  ) {
    throw new ValidationError('Invalid email format');
  }

  // Validate gender if provided
  if (
    contactData.gender &&
    !['male', 'female', 'other'].includes(contactData.gender)
  ) {
    throw new ValidationError('Gender must be one of: male, female, other');
  }

  // Validate SMS consent
  if (
    contactData.smsConsent &&
    !['opted_in', 'opted_out', 'unknown'].includes(contactData.smsConsent)
  ) {
    throw new ValidationError(
      'SMS consent must be one of: opted_in, opted_out, unknown',
    );
  }

  // Check for duplicates
  const { hasDuplicate, duplicate } = await checkDuplicates(
    storeId,
    phoneE164,
    contactData.email,
  );

  if (hasDuplicate) {
    throw new ConflictError(
      `Contact already exists with ${duplicate.phoneE164 === phoneE164 ? 'phone' : 'email'}: ${duplicate.phoneE164 === phoneE164 ? phoneE164 : contactData.email}`,
    );
  }

  // Prepare contact data for Prisma
  const prismaData = {
    shopId: storeId,
    phoneE164,
    firstName:
      contactData.firstName && contactData.firstName.trim()
        ? contactData.firstName.trim()
        : null,
    lastName:
      contactData.lastName && contactData.lastName.trim()
        ? contactData.lastName.trim()
        : null,
    email:
      contactData.email && contactData.email.trim()
        ? contactData.email.trim()
        : null,
    gender: contactData.gender || null,
    smsConsent: contactData.smsConsent || 'unknown',
    tags: contactData.tags || [],
  };

  // Handle birthDate conversion
  if (contactData.birthDate) {
    if (
      typeof contactData.birthDate === 'string' &&
      contactData.birthDate.trim()
    ) {
      const birthDate = new Date(contactData.birthDate);
      if (!isNaN(birthDate.getTime())) {
        // Validate birth date is not in the future
        if (birthDate > new Date()) {
          throw new ValidationError('Birth date cannot be in the future');
        }
        prismaData.birthDate = birthDate;
      } else {
        throw new ValidationError('Invalid birth date format');
      }
    } else if (contactData.birthDate instanceof Date) {
      if (contactData.birthDate > new Date()) {
        throw new ValidationError('Birth date cannot be in the future');
      }
      prismaData.birthDate = contactData.birthDate;
    }
  } else {
    prismaData.birthDate = null;
  }

  // Log data before creation for debugging
  logger.info('Creating contact with data', {
    storeId,
    phoneE164,
    firstName: prismaData.firstName,
    lastName: prismaData.lastName,
    gender: prismaData.gender,
    birthDate: prismaData.birthDate,
    smsConsent: prismaData.smsConsent,
  });

  // Create contact
  const contact = await prisma.contact.create({
    data: prismaData,
  });

  logger.info('Contact created successfully', {
    storeId,
    contactId: contact.id,
  });

  // Trigger welcome automation if contact has opted in and welcome automation is active
  if (contact.smsConsent === 'opted_in') {
    try {
      const hasWelcomeAutomation = await hasActiveAutomation(
        storeId,
        'welcome',
      );

      if (hasWelcomeAutomation) {
        logger.info('Queueing welcome automation for new contact', {
          storeId,
          contactId: contact.id,
          phoneE164: contact.phoneE164,
        });

        // Queue welcome automation job
        await automationQueue.add(
          'welcome',
          {
            shopId: storeId,
            contactId: contact.id,
            welcomeData: {
              firstName: contact.firstName,
              lastName: contact.lastName,
              email: contact.email,
              phoneE164: contact.phoneE164,
            },
          },
          {
            jobId: `welcome-${storeId}-${contact.id}-${Date.now()}`,
            attempts: 3,
            backoff: {
              type: 'exponential',
              delay: 2000,
            },
          },
        );

        logger.info('Welcome automation queued successfully', {
          storeId,
          contactId: contact.id,
        });
      } else {
        logger.debug('No active welcome automation found for shop', {
          storeId,
          contactId: contact.id,
        });
      }
    } catch (automationError) {
      // Log error but don't fail contact creation
      logger.error('Failed to trigger welcome automation', {
        storeId,
        contactId: contact.id,
        error: automationError.message,
        stack: automationError.stack,
      });
    }
  } else {
    logger.debug(
      'Contact does not have SMS consent, skipping welcome automation',
      {
        storeId,
        contactId: contact.id,
        smsConsent: contact.smsConsent,
      },
    );
  }

  return contact;
}

/**
 * Update contact
 * @param {string} storeId - Store ID
 * @param {string} contactId - Contact ID
 * @param {Object} contactData - Updated contact data
 * @returns {Promise<Object>} Updated contact
 */
export async function updateContact(storeId, contactId, contactData) {
  logger.info('Updating contact', { storeId, contactId });

  // Check if contact exists
  const existing = await prisma.contact.findFirst({
    where: { id: contactId, shopId: storeId },
  });

  if (!existing) {
    throw new NotFoundError('Contact');
  }

  // Prepare update data
  const updateData = {};

  // Validate and normalize phone if provided
  if (contactData.phoneE164) {
    const phoneE164 = normalizePhone(contactData.phoneE164);
    if (!isValidPhoneE164(phoneE164)) {
      throw new ValidationError(
        'Invalid phone number format. Use E.164 format (e.g., +306977123456)',
      );
    }

    // Check for duplicates
    const { hasDuplicate } = await checkDuplicates(
      storeId,
      phoneE164,
      null,
      contactId,
    );
    if (hasDuplicate) {
      throw new ConflictError(
        `Contact already exists with phone: ${phoneE164}`,
      );
    }

    updateData.phoneE164 = phoneE164;
  }

  // Validate and update email if provided
  if (contactData.email !== undefined) {
    const emailValue =
      contactData.email && contactData.email.trim()
        ? contactData.email.trim()
        : null;
    if (emailValue && !isValidEmail(emailValue)) {
      throw new ValidationError('Invalid email format');
    }

    if (emailValue) {
      const { hasDuplicate } = await checkDuplicates(
        storeId,
        null,
        emailValue,
        contactId,
      );
      if (hasDuplicate) {
        throw new ConflictError(
          `Contact already exists with email: ${emailValue}`,
        );
      }
    }

    updateData.email = emailValue;
  }

  // Validate gender if provided
  if (contactData.gender !== undefined) {
    if (
      contactData.gender &&
      !['male', 'female', 'other'].includes(contactData.gender)
    ) {
      throw new ValidationError('Gender must be one of: male, female, other');
    }
    updateData.gender = contactData.gender;
  }

  // Validate SMS consent if provided
  if (contactData.smsConsent !== undefined) {
    if (
      !['opted_in', 'opted_out', 'unknown'].includes(contactData.smsConsent)
    ) {
      throw new ValidationError(
        'SMS consent must be one of: opted_in, opted_out, unknown',
      );
    }
    updateData.smsConsent = contactData.smsConsent;
  }

  // Update other fields
  if (contactData.firstName !== undefined) {
    updateData.firstName =
      contactData.firstName && contactData.firstName.trim()
        ? contactData.firstName.trim()
        : null;
  }
  if (contactData.lastName !== undefined) {
    updateData.lastName =
      contactData.lastName && contactData.lastName.trim()
        ? contactData.lastName.trim()
        : null;
  }
  if (contactData.birthDate !== undefined) {
    if (
      contactData.birthDate &&
      typeof contactData.birthDate === 'string' &&
      contactData.birthDate.trim()
    ) {
      const birthDate = new Date(contactData.birthDate);
      if (isNaN(birthDate.getTime())) {
        throw new ValidationError('Invalid birth date format');
      }
      // Ensure birth date is not in the future
      if (birthDate > new Date()) {
        throw new ValidationError('Birth date cannot be in the future');
      }
      updateData.birthDate = birthDate;
    } else if (contactData.birthDate === null) {
      updateData.birthDate = null;
    } else if (!contactData.birthDate) {
      // Empty string or falsy value
      updateData.birthDate = null;
    } else {
      // Try to parse as Date object if it's already a Date
      const birthDate =
        contactData.birthDate instanceof Date
          ? contactData.birthDate
          : new Date(contactData.birthDate);
      if (isNaN(birthDate.getTime())) {
        throw new ValidationError('Invalid birth date format');
      }
      if (birthDate > new Date()) {
        throw new ValidationError('Birth date cannot be in the future');
      }
      updateData.birthDate = birthDate;
    }
  }
  if (contactData.tags !== undefined) updateData.tags = contactData.tags || [];

  // Check if there's anything to update
  if (Object.keys(updateData).length === 0) {
    logger.warn('No fields to update', { storeId, contactId });
    // Return existing contact if no updates
    return existing;
  }

  // Update contact
  try {
    const contact = await prisma.contact.update({
      where: { id: contactId },
      data: updateData,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        phoneE164: true,
        email: true,
        gender: true,
        birthDate: true,
        smsConsent: true,
        tags: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    logger.info('Contact updated successfully', { storeId, contactId });

    return contact;
  } catch (error) {
    // Handle Prisma-specific errors
    if (error.code === 'P2002') {
      // Unique constraint violation
      const field = error.meta?.target?.[0] || 'field';
      logger.error('Duplicate contact detected during update', {
        storeId,
        contactId,
        field,
        updateData,
        error: error.message,
      });
      throw new ConflictError(`Contact already exists with this ${field}`);
    } else if (error.code === 'P2025') {
      // Record not found
      logger.error('Contact not found during update', {
        storeId,
        contactId,
        updateData,
        error: error.message,
      });
      throw new NotFoundError('Contact');
    }

    logger.error('Failed to update contact in database', {
      storeId,
      contactId,
      updateData,
      error: error.message,
      errorCode: error.code,
      errorMeta: error.meta,
      stack: error.stack,
    });
    throw error;
  }
}

/**
 * Delete contact
 * @param {string} storeId - Store ID
 * @param {string} contactId - Contact ID
 * @returns {Promise<void>}
 */
export async function deleteContact(storeId, contactId) {
  logger.info('Deleting contact', { storeId, contactId });

  // Check if contact exists
  const existing = await prisma.contact.findFirst({
    where: { id: contactId, shopId: storeId },
  });

  if (!existing) {
    throw new NotFoundError('Contact');
  }

  // Delete contact
  await prisma.contact.delete({
    where: { id: contactId },
  });

  logger.info('Contact deleted successfully', { storeId, contactId });
}

/**
 * Get contact statistics
 * @param {string} storeId - Store ID
 * @returns {Promise<Object>} Contact statistics
 */
export async function getContactStats(storeId) {
  logger.info('Getting contact stats', { storeId });

  const [total, genderStats, consentStats, withBirthday] = await Promise.all([
    prisma.contact.count({ where: { shopId: storeId } }),
    prisma.contact.groupBy({
      by: ['gender'],
      where: { shopId: storeId },
      _count: { gender: true },
    }),
    prisma.contact.groupBy({
      by: ['smsConsent'],
      where: { shopId: storeId },
      _count: { smsConsent: true },
    }),
    prisma.contact.count({
      where: { shopId: storeId, birthDate: { not: null } },
    }),
  ]);

  const stats = {
    total,
    byGender: {
      male: genderStats.find(s => s.gender === 'male')?._count?.gender || 0,
      female: genderStats.find(s => s.gender === 'female')?._count?.gender || 0,
      other: genderStats.find(s => s.gender === 'other')?._count?.gender || 0,
      unknown: total - genderStats.reduce((sum, s) => sum + s._count.gender, 0),
    },
    byConsent: {
      opted_in:
        consentStats.find(s => s.smsConsent === 'opted_in')?._count
          ?.smsConsent || 0,
      opted_out:
        consentStats.find(s => s.smsConsent === 'opted_out')?._count
          ?.smsConsent || 0,
      unknown:
        consentStats.find(s => s.smsConsent === 'unknown')?._count
          ?.smsConsent || 0,
    },
    withBirthday,
  };

  logger.info('Contact stats retrieved', { storeId, stats });

  return stats;
}

/**
 * Get birthday contacts (upcoming birthdays)
 * @param {string} storeId - Store ID
 * @param {number} daysAhead - Number of days to look ahead (default: 7)
 * @returns {Promise<Array>} Contacts with upcoming birthdays
 */
export async function getBirthdayContacts(storeId, daysAhead = 7) {
  logger.info('Getting birthday contacts', { storeId, daysAhead });

  const today = new Date();
  const futureDate = new Date();
  futureDate.setDate(today.getDate() + daysAhead);

  // Get all contacts with birthdays
  const contacts = await prisma.contact.findMany({
    where: {
      shopId: storeId,
      birthDate: { not: null },
      smsConsent: 'opted_in',
    },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      phoneE164: true,
      email: true,
      birthDate: true,
    },
  });

  // Filter contacts with birthdays in the next N days
  const upcomingBirthdays = contacts.filter(contact => {
    const birthDate = new Date(contact.birthDate);
    const thisYearBirthday = new Date(
      today.getFullYear(),
      birthDate.getMonth(),
      birthDate.getDate(),
    );

    // If birthday already passed this year, check next year
    if (thisYearBirthday < today) {
      thisYearBirthday.setFullYear(today.getFullYear() + 1);
    }

    return thisYearBirthday >= today && thisYearBirthday <= futureDate;
  });

  logger.info('Birthday contacts retrieved', {
    storeId,
    total: upcomingBirthdays.length,
  });

  return upcomingBirthdays;
}

/**
 * Import contacts in bulk
 * @param {string} storeId - Store ID
 * @param {Array} contactsData - Array of contact data
 * @returns {Promise<Object>} Import results
 */
export async function importContacts(storeId, contactsData) {
  logger.info('Importing contacts', { storeId, count: contactsData.length });

  const results = {
    total: contactsData.length,
    created: 0,
    updated: 0,
    skipped: 0,
    errors: [],
  };

  for (const contactData of contactsData) {
    try {
      // Normalize phone
      const phoneE164 = normalizePhone(contactData.phoneE164);

      if (!isValidPhoneE164(phoneE164)) {
        results.skipped++;
        results.errors.push({
          phone: contactData.phoneE164,
          error: 'Invalid phone format',
        });
        continue;
      }

      // Check if contact exists
      const existing = await prisma.contact.findFirst({
        where: { shopId: storeId, phoneE164 },
      });

      if (existing) {
        // Update existing contact
        await prisma.contact.update({
          where: { id: existing.id },
          data: {
            firstName: contactData.firstName || existing.firstName,
            lastName: contactData.lastName || existing.lastName,
            email: contactData.email || existing.email,
            gender: contactData.gender || existing.gender,
            birthDate: contactData.birthDate
              ? new Date(contactData.birthDate)
              : existing.birthDate,
            smsConsent: contactData.smsConsent || existing.smsConsent,
            tags: contactData.tags || existing.tags,
          },
        });
        results.updated++;
      } else {
        // Create new contact
        await prisma.contact.create({
          data: {
            shopId: storeId,
            phoneE164,
            firstName: contactData.firstName || null,
            lastName: contactData.lastName || null,
            email: contactData.email || null,
            gender: contactData.gender || null,
            birthDate: contactData.birthDate
              ? new Date(contactData.birthDate)
              : null,
            smsConsent: contactData.smsConsent || 'unknown',
            tags: contactData.tags || [],
          },
        });
        results.created++;
      }
    } catch (error) {
      results.skipped++;
      results.errors.push({
        phone: contactData.phoneE164,
        error: error.message,
      });
    }
  }

  logger.info('Contacts imported', { storeId, results });

  return results;
}

export { normalizePhone, isValidPhoneE164, isValidEmail };

export default {
  listContacts,
  getContactById,
  createContact,
  updateContact,
  deleteContact,
  getContactStats,
  getBirthdayContacts,
  importContacts,
  normalizePhone,
  isValidPhoneE164,
  isValidEmail,
};
