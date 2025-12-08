import prisma from './prisma.js';
import { logger } from '../utils/logger.js';
import { ValidationError, NotFoundError } from '../utils/errors.js';
import {
  validateAndConsumeCredits,
  InsufficientCreditsError,
  refundCredits,
} from './credit-validation.js';
import { smsQueue } from '../queue/index.js';
import { appendUnsubscribeLink } from '../utils/unsubscribe.js';
import { replacePlaceholders } from '../utils/personalization.js';
import { getDiscountCode } from './shopify.js';

/**
 * Campaigns Service
 * Handles campaign management, scheduling, sending, and metrics
 */

/**
 * Normalize audience query to Prisma where clause
 * @param {string} audience - Audience filter
 * @returns {Object|null} Prisma where clause
 */
function normalizeAudienceQuery(audience) {
  if (!audience || audience === 'all') {
    return { smsConsent: 'opted_in' };
  }
  if (audience === 'men' || audience === 'male') {
    return { smsConsent: 'opted_in', gender: 'male' };
  }
  if (audience === 'women' || audience === 'female') {
    return { smsConsent: 'opted_in', gender: 'female' };
  }
  if (audience.startsWith('segment:')) {
    return null; // Handle separately
  }
  return { smsConsent: 'opted_in' };
}

/**
 * Resolve recipients based on audience
 * @param {string} shopId - Store ID
 * @param {string} audience - Audience filter
 * @returns {Promise<Array>} Array of recipients
 */
async function resolveRecipients(shopId, audience) {
  logger.info('Resolving recipients', { shopId, audience });

  const base = normalizeAudienceQuery(audience);

  if (base) {
    const contacts = await prisma.contact.findMany({
      where: { shopId, ...base },
      select: { id: true, phoneE164: true, firstName: true, lastName: true },
    });
    return contacts.map(c => ({
      contactId: c.id,
      phoneE164: c.phoneE164,
      firstName: c.firstName,
      lastName: c.lastName,
    }));
  }

  // Handle segment-based audience
  if (audience.startsWith('segment:')) {
    const segmentId = audience.split(':')[1];

    // ✅ Security: First validate segment belongs to shop
    const segment = await prisma.segment.findFirst({
      where: {
        id: segmentId,
        shopId, // ✅ Validate segment ownership
      },
      select: { id: true },
    });

    if (!segment) {
      logger.warn('Segment not found or does not belong to shop', {
        segmentId,
        shopId,
      });
      return []; // Return empty if segment doesn't belong to shop
    }

    // ✅ Security: Query memberships with shopId filter at database level
    const members = await prisma.segmentMembership.findMany({
      where: {
        segmentId,
        contact: {
          shopId, // ✅ Filter at database level for efficiency and security
          smsConsent: 'opted_in',
        },
      },
      include: {
        contact: {
          select: {
            id: true,
            phoneE164: true,
            firstName: true,
            lastName: true,
          },
        },
      },
    });

    return members.map(m => ({
      contactId: m.contactId,
      phoneE164: m.contact.phoneE164,
      firstName: m.contact.firstName,
      lastName: m.contact.lastName,
    }));
  }

  return [];
}

/**
 * Stream recipients for large campaigns (prevents memory issues with 100k+ recipients)
 * @param {string} shopId - Store ID
 * @param {string} audience - Audience filter
 * @param {number} batchSize - Batch size for streaming (default: 1000)
 * @returns {AsyncGenerator<Array>} Generator that yields batches of recipients
 */
async function* streamRecipients(shopId, audience, batchSize = 1000) {
  logger.info('Streaming recipients', { shopId, audience, batchSize });

  const base = normalizeAudienceQuery(audience);
  let offset = 0;

  if (base) {
    // Stream contacts for predefined audiences
    while (true) {
      const batch = await prisma.contact.findMany({
        where: { shopId, ...base },
        select: { id: true, phoneE164: true, firstName: true, lastName: true },
        take: batchSize,
        skip: offset,
      });

      if (batch.length === 0) break;

      yield batch.map(c => ({
        contactId: c.id,
        phoneE164: c.phoneE164,
        firstName: c.firstName,
        lastName: c.lastName,
      }));
      offset += batchSize;
    }
  } else if (audience.startsWith('segment:')) {
    // Stream segment memberships
    const segmentId = audience.split(':')[1];

    // Validate segment
    const segment = await prisma.segment.findFirst({
      where: { id: segmentId, shopId },
      select: { id: true },
    });

    if (!segment) {
      logger.warn('Segment not found', { segmentId, shopId });
      return;
    }

    while (true) {
      const batch = await prisma.segmentMembership.findMany({
        where: {
          segmentId,
          contact: {
            shopId,
            smsConsent: 'opted_in',
          },
        },
        include: {
          contact: {
            select: {
              id: true,
              phoneE164: true,
              firstName: true,
              lastName: true,
            },
          },
        },
        take: batchSize,
        skip: offset,
      });

      if (batch.length === 0) break;

      yield batch.map(m => ({
        contactId: m.contactId,
        phoneE164: m.contact.phoneE164,
        firstName: m.contact.firstName,
        lastName: m.contact.lastName,
      }));
      offset += batchSize;
    }
  }
}

/**
 * Calculate recipient count without fetching all data
 * @param {string} shopId - Store ID
 * @param {string} audience - Audience filter
 * @returns {Promise<number>} Recipient count
 */
// Unused function - kept for potential future API use
// eslint-disable-next-line no-unused-vars
async function calculateRecipientCount(shopId, audience) {
  const base = normalizeAudienceQuery(audience);

  if (base) {
    return await prisma.contact.count({
      where: { shopId, ...base },
    });
  }

  if (audience.startsWith('segment:')) {
    const segmentId = audience.split(':')[1];

    // ✅ Security: Validate segment belongs to shop
    const segment = await prisma.segment.findFirst({
      where: {
        id: segmentId,
        shopId,
      },
      select: { id: true },
    });

    if (!segment) {
      return 0; // Segment doesn't belong to shop
    }

    // ✅ Security: Count with shopId filter at database level
    return await prisma.segmentMembership.count({
      where: {
        segmentId,
        contact: {
          shopId,
          smsConsent: 'opted_in',
        },
      },
    });
  }

  return 0;
}

/**
 * Validate campaign data
 * @param {Object} campaignData - Campaign data to validate
 * @throws {ValidationError} If validation fails
 */
function validateCampaignData(campaignData) {
  if (!campaignData.name || campaignData.name.trim().length === 0) {
    throw new ValidationError('Campaign name is required');
  }

  if (!campaignData.message || campaignData.message.trim().length === 0) {
    throw new ValidationError('Campaign message is required');
  }

  if (campaignData.message.length > 1600) {
    throw new ValidationError('Message is too long (max 1600 characters)');
  }

  if (
    !['immediate', 'scheduled', 'recurring'].includes(campaignData.scheduleType)
  ) {
    throw new ValidationError('Invalid schedule type');
  }

  if (campaignData.scheduleType === 'scheduled' && !campaignData.scheduleAt) {
    throw new ValidationError(
      'Schedule date is required for scheduled campaigns',
    );
  }

  if (
    campaignData.scheduleType === 'recurring' &&
    !campaignData.recurringDays
  ) {
    throw new ValidationError(
      'Recurring days is required for recurring campaigns',
    );
  }
}

/**
 * List campaigns with optional filtering and pagination
 * @param {string} storeId - Store ID
 * @param {Object} filters - Filter options
 * @returns {Promise<Object>} Campaigns list
 */
export async function listCampaigns(storeId, filters = {}) {
  const {
    page = 1,
    pageSize = 20,
    status,
    sortBy = 'createdAt',
    sortOrder = 'desc',
  } = filters;

  logger.info('Listing campaigns', { storeId, filters });

  const where = { shopId: storeId };

  if (
    status &&
    ['draft', 'scheduled', 'sending', 'sent', 'failed', 'cancelled'].includes(
      status,
    )
  ) {
    where.status = status;
  }

  const validSortFields = ['createdAt', 'updatedAt', 'name', 'scheduleAt'];
  const sortField = validSortFields.includes(sortBy) ? sortBy : 'createdAt';
  const sortDirection = sortOrder === 'asc' ? 'asc' : 'desc';

  const [campaigns, total] = await Promise.all([
    prisma.campaign.findMany({
      where,
      orderBy: { [sortField]: sortDirection },
      take: parseInt(pageSize),
      skip: (parseInt(page) - 1) * parseInt(pageSize),
      include: {
        metrics: true,
      },
    }),
    prisma.campaign.count({ where }),
  ]);

  // Get recipient counts for all campaigns in parallel
  // For sent campaigns, count actual CampaignRecipient records
  // For scheduled/draft campaigns, calculate based on audience
  const campaignsWithRecipientCounts = await Promise.all(
    campaigns.map(async campaign => {
      let recipientCount = 0;

      // If campaign has been sent (status is 'sending' or 'sent'), count actual recipients
      if (
        campaign.status === 'sending' ||
        campaign.status === 'sent' ||
        campaign.status === 'failed'
      ) {
        recipientCount = await prisma.campaignRecipient.count({
          where: { campaignId: campaign.id },
        });
      } else {
        // For draft/scheduled campaigns, calculate recipient count based on audience
        const base = normalizeAudienceQuery(campaign.audience);
        if (base) {
          recipientCount = await prisma.contact.count({
            where: { shopId: storeId, ...base },
          });
        } else if (campaign.audience.startsWith('segment:')) {
          const segmentId = campaign.audience.split(':')[1];
          // Validate segment belongs to shop
          const segment = await prisma.segment.findFirst({
            where: {
              id: segmentId,
              shopId: storeId,
            },
            select: { id: true },
          });

          if (segment) {
            recipientCount = await prisma.segmentMembership.count({
              where: {
                segmentId,
                contact: {
                  shopId: storeId,
                  smsConsent: 'opted_in',
                },
              },
            });
          }
        }
      }

      return {
        ...campaign,
        recipientCount,
        totalRecipients: recipientCount, // Alias for backward compatibility
      };
    }),
  );

  const totalPages = Math.ceil(total / parseInt(pageSize));

  logger.info('Campaigns listed successfully', {
    storeId,
    total,
    returned: campaigns.length,
  });

  return {
    campaigns: campaignsWithRecipientCounts,
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
 * Get campaign by ID
 * @param {string} storeId - Store ID
 * @param {string} campaignId - Campaign ID
 * @returns {Promise<Object>} Campaign data
 */
export async function getCampaignById(storeId, campaignId) {
  logger.info('Getting campaign by ID', { storeId, campaignId });

  const campaign = await prisma.campaign.findFirst({
    where: {
      id: campaignId,
      shopId: storeId,
    },
    include: {
      metrics: true,
      recipients: {
        take: 100, // Limit recipients for performance
      },
    },
  });

  if (!campaign) {
    throw new NotFoundError('Campaign');
  }

  // Get recipient count
  // For sent campaigns, count actual CampaignRecipient records
  // For scheduled/draft campaigns, calculate based on audience
  let recipientCount = 0;

  if (
    campaign.status === 'sending' ||
    campaign.status === 'sent' ||
    campaign.status === 'failed'
  ) {
    // Count actual recipients for campaigns that have been sent
    recipientCount = await prisma.campaignRecipient.count({
      where: { campaignId },
    });
  } else {
    // For draft/scheduled campaigns, calculate recipient count based on audience
    const base = normalizeAudienceQuery(campaign.audience);
    if (base) {
      recipientCount = await prisma.contact.count({
        where: { shopId: storeId, ...base },
      });
    } else if (campaign.audience.startsWith('segment:')) {
      const segmentId = campaign.audience.split(':')[1];
      // Validate segment belongs to shop
      const segment = await prisma.segment.findFirst({
        where: {
          id: segmentId,
          shopId: storeId,
        },
        select: { id: true },
      });

      if (segment) {
        recipientCount = await prisma.segmentMembership.count({
          where: {
            segmentId,
            contact: {
              shopId: storeId,
              smsConsent: 'opted_in',
            },
          },
        });
      }
    }
  }

  logger.info('Campaign retrieved successfully', {
    storeId,
    campaignId,
    recipientCount,
    status: campaign.status,
  });

  return {
    ...campaign,
    recipientCount,
    totalRecipients: recipientCount, // Alias for backward compatibility
  };
}

/**
 * Create new campaign
 * @param {string} storeId - Store ID
 * @param {Object} campaignData - Campaign data
 * @returns {Promise<Object>} Created campaign
 */
export async function createCampaign(storeId, campaignData) {
  logger.info('Creating campaign', { storeId, name: campaignData.name });

  // Validate campaign data
  validateCampaignData(campaignData);

  // Validate and parse scheduleAt date if provided
  let scheduleAtDate = null;
  if (campaignData.scheduleAt) {
    try {
      scheduleAtDate = new Date(campaignData.scheduleAt);
      if (isNaN(scheduleAtDate.getTime())) {
        throw new ValidationError(
          'Invalid schedule date format. Please use ISO 8601 format.',
        );
      }
      // Validate that scheduled date is in the future
      if (scheduleAtDate <= new Date()) {
        throw new ValidationError('Schedule date must be in the future');
      }
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      throw new ValidationError(`Invalid schedule date: ${error.message}`);
    }
  }

  // Use transaction to ensure both campaign and metrics are created atomically
  const result = await prisma.$transaction(async tx => {
    // Create campaign
    const campaign = await tx.campaign.create({
      data: {
        shopId: storeId,
        name: campaignData.name.trim(),
        message: campaignData.message.trim(),
        audience: campaignData.audience || 'all',
        discountId: campaignData.discountId || null,
        scheduleType: campaignData.scheduleType || 'immediate',
        scheduleAt: scheduleAtDate,
        recurringDays: campaignData.recurringDays || null,
        status: 'draft',
      },
    });

    // Create metrics record
    await tx.campaignMetrics.create({
      data: { campaignId: campaign.id },
    });

    return campaign;
  });

  logger.info('Campaign created successfully', {
    storeId,
    campaignId: result.id,
  });

  return result;
}

/**
 * Update campaign
 * @param {string} storeId - Store ID
 * @param {string} campaignId - Campaign ID
 * @param {Object} campaignData - Updated campaign data
 * @returns {Promise<Object>} Updated campaign
 */
export async function updateCampaign(storeId, campaignId, campaignData) {
  logger.info('Updating campaign', { storeId, campaignId });

  // Check if campaign exists and belongs to store
  const existing = await prisma.campaign.findFirst({
    where: { id: campaignId, shopId: storeId },
  });

  if (!existing) {
    throw new NotFoundError('Campaign');
  }

  // Can't update sent or sending campaigns
  if (existing.status === 'sent' || existing.status === 'sending') {
    throw new ValidationError(
      'Cannot update a campaign that has already been sent or is currently sending',
    );
  }

  // Prepare update data
  const updateData = {};

  if (campaignData.name !== undefined) {
    if (!campaignData.name || campaignData.name.trim().length === 0) {
      throw new ValidationError('Campaign name is required');
    }
    updateData.name = campaignData.name.trim();
  }

  if (campaignData.message !== undefined) {
    if (!campaignData.message || campaignData.message.trim().length === 0) {
      throw new ValidationError('Campaign message is required');
    }
    if (campaignData.message.length > 1600) {
      throw new ValidationError('Message is too long (max 1600 characters)');
    }
    updateData.message = campaignData.message.trim();
  }

  if (campaignData.audience !== undefined)
    updateData.audience = campaignData.audience;
  if (campaignData.discountId !== undefined)
    updateData.discountId = campaignData.discountId;
  if (campaignData.scheduleType !== undefined) {
    updateData.scheduleType = campaignData.scheduleType;
    // If changing from scheduled to immediate, clear scheduleAt and set status to draft
    if (
      campaignData.scheduleType === 'immediate' &&
      existing.scheduleType === 'scheduled'
    ) {
      updateData.scheduleAt = null;
      updateData.status = 'draft';
    }
    // If changing to scheduled, status will be set by schedule endpoint
  }
  if (campaignData.scheduleAt !== undefined) {
    if (campaignData.scheduleAt) {
      const scheduleAtDate = new Date(campaignData.scheduleAt);
      if (isNaN(scheduleAtDate.getTime())) {
        throw new ValidationError(
          'Invalid schedule date format. Please use ISO 8601 format.',
        );
      }
      if (scheduleAtDate <= new Date()) {
        throw new ValidationError('Schedule date must be in the future');
      }
      updateData.scheduleAt = scheduleAtDate;
    } else {
      updateData.scheduleAt = null;
    }
  }
  if (campaignData.recurringDays !== undefined)
    updateData.recurringDays = campaignData.recurringDays;

  // Update campaign
  const campaign = await prisma.campaign.update({
    where: { id: campaignId },
    data: updateData,
  });

  logger.info('Campaign updated successfully', { storeId, campaignId });

  return campaign;
}

/**
 * Delete campaign
 * @param {string} storeId - Store ID
 * @param {string} campaignId - Campaign ID
 * @returns {Promise<void>}
 */
export async function deleteCampaign(storeId, campaignId) {
  logger.info('Deleting campaign', { storeId, campaignId });

  // Check if campaign exists and belongs to store
  const existing = await prisma.campaign.findFirst({
    where: { id: campaignId, shopId: storeId },
  });

  if (!existing) {
    throw new NotFoundError('Campaign');
  }

  // Can't delete sent campaigns
  if (existing.status === 'sent' || existing.status === 'sending') {
    throw new ValidationError(
      'Cannot delete a campaign that is sent or currently sending',
    );
  }

  // Delete campaign (metrics and recipients will cascade)
  await prisma.campaign.delete({
    where: { id: campaignId },
  });

  logger.info('Campaign deleted successfully', { storeId, campaignId });
}

/**
 * Prepare campaign for sending (calculate recipients and validate credits)
 * @param {string} storeId - Store ID
 * @param {string} campaignId - Campaign ID
 * @returns {Promise<Object>} Preparation result
 */
export async function prepareCampaign(storeId, campaignId) {
  logger.info('Preparing campaign', { storeId, campaignId });

  const campaign = await prisma.campaign.findFirst({
    where: { id: campaignId, shopId: storeId },
  });

  if (!campaign) {
    throw new NotFoundError('Campaign');
  }

  if (campaign.status !== 'draft') {
    throw new ValidationError('Only draft campaigns can be prepared');
  }

  // Calculate recipients
  const recipients = await resolveRecipients(storeId, campaign.audience);
  const recipientCount = recipients.length;

  if (recipientCount === 0) {
    throw new ValidationError('No recipients found for this campaign');
  }

  // Check credits (without consuming)
  const shop = await prisma.shop.findUnique({
    where: { id: storeId },
    select: { credits: true },
  });

  if (shop.credits < recipientCount) {
    throw new InsufficientCreditsError(recipientCount, shop.credits);
  }

  logger.info('Campaign prepared successfully', {
    storeId,
    campaignId,
    recipientCount,
    creditsAvailable: shop.credits,
  });

  return {
    recipientCount,
    creditsRequired: recipientCount,
    creditsAvailable: shop.credits,
    canSend: shop.credits >= recipientCount,
  };
}

/**
 * Send campaign immediately
 * @param {string} storeId - Store ID
 * @param {string} campaignId - Campaign ID
 * @returns {Promise<Object>} Send result
 */
export async function sendCampaign(storeId, campaignId) {
  logger.info('Sending campaign', { storeId, campaignId });

  const campaign = await prisma.campaign.findFirst({
    where: { id: campaignId, shopId: storeId },
  });

  if (!campaign) {
    throw new NotFoundError('Campaign');
  }

  // Allow 'draft', 'scheduled', and 'sending' campaigns to be sent
  // 'draft' campaigns are sent immediately (Send Now)
  // 'scheduled' campaigns are sent when their scheduleAt time arrives
  // 'sending' status means the scheduler already queued it (prevents duplicate processing)
  if (
    campaign.status !== 'draft' &&
    campaign.status !== 'scheduled' &&
    campaign.status !== 'sending'
  ) {
    throw new ValidationError(
      'Only draft, scheduled, or sending campaigns can be sent',
    );
  }

  // Get recipient count first (for credit validation)
  // Use efficient count query first, then resolve recipients for actual sending
  let recipients = [];
  let recipientCount = 0;

  // First, get count using efficient count query
  const base = normalizeAudienceQuery(campaign.audience);
  if (base) {
    recipientCount = await prisma.contact.count({
      where: { shopId: storeId, ...base },
    });
  } else if (campaign.audience.startsWith('segment:')) {
    const segmentId = campaign.audience.split(':')[1];
    recipientCount = await prisma.segmentMembership.count({
      where: {
        segmentId,
        contact: {
          shopId: storeId,
          smsConsent: 'opted_in',
        },
      },
    });
  }

  if (recipientCount === 0) {
    throw new ValidationError('No recipients found for this campaign');
  }

  logger.info('Recipient count calculated', {
    storeId,
    campaignId,
    audience: campaign.audience,
    recipientCount,
  });

  // Validate and consume credits upfront
  // If campaign fails before any SMS is sent, credits will be refunded
  let creditsConsumed = false;
  await validateAndConsumeCredits(
    storeId,
    recipientCount,
    `campaign:${campaignId}`,
  );
  creditsConsumed = true;

  // Update campaign status
  try {
    await prisma.campaign.update({
      where: { id: campaignId },
      data: { status: 'sending' },
    });
  } catch (error) {
    // If status update fails, refund credits
    if (creditsConsumed) {
      logger.error('Campaign status update failed, refunding credits', {
        storeId,
        campaignId,
        recipientCount,
        error: error.message,
      });
      await refundCredits(
        storeId,
        recipientCount,
        `campaign:${campaignId}:rollback:status_update_failed`,
      );
    }
    throw error;
  }

  // Get sender configuration for the shop
  const shopSettings = await prisma.shopSettings.findUnique({
    where: { shopId: storeId },
    select: { senderName: true, senderNumber: true },
  });
  const sender =
    shopSettings?.senderName ||
    shopSettings?.senderNumber ||
    process.env.MITTO_SENDER_NAME ||
    'Astronote';

  // Use streaming for large campaigns to avoid memory issues
  // For campaigns with 10k+ recipients, use streaming
  const USE_STREAMING = recipientCount > 10000;
  const BATCH_SIZE = 1000;
  let totalQueued = 0;
  let totalRecipientsCreated = 0;

  // Fetch discount code if campaign has a discountId (fetch once, use for all recipients)
  let discountCode = '';
  if (campaign.discountId) {
    try {
      // Get shop domain from store
      const store = await prisma.shop.findUnique({
        where: { id: storeId },
        select: { shopDomain: true },
      });

      if (store?.shopDomain) {
        const discount = await getDiscountCode(
          store.shopDomain,
          campaign.discountId,
        );
        discountCode = discount?.code || '';
        logger.info('Discount code fetched for campaign', {
          storeId,
          campaignId,
          discountId: campaign.discountId,
          discountCode,
        });
      } else {
        logger.warn('Shop domain not found, cannot fetch discount code', {
          storeId,
          campaignId,
          discountId: campaign.discountId,
        });
      }
    } catch (error) {
      // Log error but continue sending campaign without discount code
      logger.error('Failed to fetch discount code for campaign', {
        storeId,
        campaignId,
        discountId: campaign.discountId,
        error: error.message,
      });
      // Continue with empty discount code
    }
  }

  try {
    if (USE_STREAMING) {
      logger.info('Using stream processing for large campaign', {
        campaignId,
        recipientCount,
      });

      // Stream recipients and process in batches
      for await (const recipientBatch of streamRecipients(
        storeId,
        campaign.audience,
        BATCH_SIZE,
      )) {
        // Create recipient records in batch
        await prisma.campaignRecipient.createMany({
          data: recipientBatch.map(r => ({
            campaignId,
            contactId: r.contactId,
            phoneE164: r.phoneE164,
            status: 'pending',
          })),
        });
        totalRecipientsCreated += recipientBatch.length;

        // Queue SMS jobs in batch
        // Get frontend base URL for unsubscribe links
        const frontendBaseUrl =
          process.env.FRONTEND_URL ||
          process.env.FRONTEND_BASE_URL ||
          'https://astronote-shopify-frontend.onrender.com';

        const smsJobs = recipientBatch.map(recipient => {
          // Replace personalization placeholders with contact data and discount code
          const personalizedMessage = replacePlaceholders(campaign.message, {
            firstName: recipient.firstName,
            lastName: recipient.lastName,
            discountCode,
          });

          // Append unsubscribe link to message
          const messageWithUnsubscribe = appendUnsubscribeLink(
            personalizedMessage,
            recipient.contactId,
            storeId,
            recipient.phoneE164,
            frontendBaseUrl,
          );

          return {
            name: 'sms-send',
            data: {
              campaignId,
              shopId: storeId,
              phoneE164: recipient.phoneE164,
              message: messageWithUnsubscribe,
              sender,
            },
          };
        });

        await smsQueue.addBulk(smsJobs);
        totalQueued += smsJobs.length;

        logger.info(`Streamed batch ${Math.floor(totalQueued / BATCH_SIZE)}`, {
          batchSize: recipientBatch.length,
          totalQueued,
          totalRecipientsCreated,
          total: recipientCount,
        });
      }
    } else {
      // For smaller campaigns, load all recipients at once (faster for < 10k)
      // Resolve recipients if not already resolved
      if (recipients.length === 0) {
        recipients = await resolveRecipients(storeId, campaign.audience);
      }

      if (recipients.length === 0) {
        logger.warn('No recipients resolved for campaign', {
          storeId,
          campaignId,
          audience: campaign.audience,
        });
        throw new ValidationError('No recipients found for this campaign');
      }

      // Create recipient records
      await prisma.campaignRecipient.createMany({
        data: recipients.map(r => ({
          campaignId,
          contactId: r.contactId,
          phoneE164: r.phoneE164,
          status: 'pending',
        })),
      });
      totalRecipientsCreated = recipients.length;

      // Queue SMS jobs in batches
      // Get frontend base URL for unsubscribe links
      const frontendBaseUrl =
        process.env.FRONTEND_URL ||
        process.env.FRONTEND_BASE_URL ||
        'https://astronote-shopify-frontend.onrender.com';

      const smsJobs = recipients.map(recipient => {
        // Replace personalization placeholders with contact data and discount code
        const personalizedMessage = replacePlaceholders(campaign.message, {
          firstName: recipient.firstName,
          lastName: recipient.lastName,
          discountCode,
        });

        // Append unsubscribe link to message
        const messageWithUnsubscribe = appendUnsubscribeLink(
          personalizedMessage,
          recipient.contactId,
          storeId,
          recipient.phoneE164,
          frontendBaseUrl,
        );

        return {
          name: 'sms-send',
          data: {
            campaignId,
            shopId: storeId,
            phoneE164: recipient.phoneE164,
            message: messageWithUnsubscribe,
            sender,
          },
        };
      });

      if (smsJobs.length > 0) {
        for (let i = 0; i < smsJobs.length; i += BATCH_SIZE) {
          const batch = smsJobs.slice(i, i + BATCH_SIZE);
          await smsQueue.addBulk(batch);
          totalQueued += batch.length;
        }
        logger.info('SMS jobs queued', {
          storeId,
          campaignId,
          totalQueued,
          batchCount: Math.ceil(smsJobs.length / BATCH_SIZE),
        });
      } else {
        logger.warn('No SMS jobs to queue', {
          storeId,
          campaignId,
          recipientCount,
          recipientsLength: recipients.length,
        });
      }
    }

    logger.info('Campaign queued for sending', {
      storeId,
      campaignId,
      recipientCount,
      jobsQueued: totalQueued,
      batches: Math.ceil(totalRecipientsCreated / BATCH_SIZE),
    });

    return {
      campaignId,
      recipientCount,
      status: 'sending',
      queuedAt: new Date(),
    };
  } catch (error) {
    // If campaign queuing fails after credits consumed, refund credits
    // Only refund if no SMS jobs were queued (i.e., campaign failed before any SMS sent)
    if (creditsConsumed && totalQueued === 0) {
      logger.error('Campaign queuing failed, refunding credits', {
        storeId,
        campaignId,
        recipientCount,
        totalQueued,
        error: error.message,
      });
      try {
        await refundCredits(
          storeId,
          recipientCount,
          `campaign:${campaignId}:rollback:queuing_failed`,
        );
        // Revert campaign status to draft
        await prisma.campaign.update({
          where: { id: campaignId },
          data: { status: 'draft' },
        });
      } catch (refundError) {
        logger.error('Failed to refund credits after campaign failure', {
          storeId,
          campaignId,
          recipientCount,
          refundError: refundError.message,
        });
        // Log but don't throw - the original error is more important
      }
    }
    throw error;
  }
}

/**
 * Schedule campaign for later
 * @param {string} storeId - Store ID
 * @param {string} campaignId - Campaign ID
 * @param {Object} scheduleData - Schedule data
 * @returns {Promise<Object>} Updated campaign
 *
 * Note: scheduleAt should be provided as an ISO 8601 datetime string in UTC.
 * The frontend should convert the user's selected time (in their shop's timezone)
 * to UTC before sending to this endpoint. When a scheduler processes scheduled
 * campaigns, it should use the shop's timezone setting to determine the correct
 * send time.
 */
export async function scheduleCampaign(storeId, campaignId, scheduleData) {
  logger.info('Scheduling campaign', { storeId, campaignId, scheduleData });

  const campaign = await prisma.campaign.findFirst({
    where: { id: campaignId, shopId: storeId },
  });

  if (!campaign) {
    throw new NotFoundError('Campaign');
  }

  if (!scheduleData.scheduleAt) {
    throw new ValidationError('Schedule date is required');
  }

  const scheduleAt = new Date(scheduleData.scheduleAt);

  if (isNaN(scheduleAt.getTime())) {
    throw new ValidationError(
      'Invalid schedule date format. Please use ISO 8601 format.',
    );
  }

  if (scheduleAt <= new Date()) {
    throw new ValidationError('Schedule date must be in the future');
  }

  // Get shop timezone for logging and future scheduler implementation
  const shopSettings = await prisma.shopSettings.findUnique({
    where: { shopId: storeId },
    select: { timezone: true },
  });
  const shopTimezone = shopSettings?.timezone || 'UTC';

  // Update campaign
  // Note: scheduleAt is stored in UTC. When a scheduler processes scheduled campaigns,
  // it should check campaigns where status='scheduled' and scheduleAt <= now(),
  // then call sendCampaign() for each. The scheduler should respect the shop's
  // timezone setting when determining the correct send time (though scheduleAt is in UTC).
  const updated = await prisma.campaign.update({
    where: { id: campaignId },
    data: {
      scheduleType: scheduleData.scheduleType || 'scheduled',
      scheduleAt,
      status: 'scheduled',
    },
  });

  logger.info('Campaign scheduled successfully', {
    storeId,
    campaignId,
    scheduleAt: scheduleAt.toISOString(),
    shopTimezone,
    note: 'scheduleAt is stored in UTC. Frontend converts shop timezone to UTC before sending.',
  });

  return updated;
}

/**
 * Retry failed SMS for a campaign
 * @param {string} storeId - Store ID
 * @param {string} campaignId - Campaign ID
 * @returns {Promise<Object>} Retry result
 */
export async function retryFailedSms(storeId, campaignId) {
  logger.info('Retrying failed SMS for campaign', { storeId, campaignId });

  const campaign = await prisma.campaign.findFirst({
    where: { id: campaignId, shopId: storeId },
    include: {
      settings: {
        select: { senderName: true, senderNumber: true },
      },
    },
  });

  if (!campaign) {
    throw new NotFoundError('Campaign');
  }

  // Get all failed recipients for this campaign
  const failedRecipients = await prisma.campaignRecipient.findMany({
    where: {
      campaignId,
      status: 'failed',
    },
  });

  if (failedRecipients.length === 0) {
    return {
      campaignId,
      retried: 0,
      message: 'No failed recipients to retry',
    };
  }

  // Get sender configuration
  const shopSettings = await prisma.shopSettings.findUnique({
    where: { shopId: storeId },
    select: { senderName: true, senderNumber: true },
  });
  const sender =
    shopSettings?.senderName ||
    shopSettings?.senderNumber ||
    process.env.MITTO_SENDER_NAME ||
    'Astronote';

  // Reset failed recipients to pending status
  await prisma.campaignRecipient.updateMany({
    where: {
      campaignId,
      status: 'failed',
    },
    data: {
      status: 'pending',
      error: null,
    },
  });

  // Queue retry jobs for failed recipients
  const retryJobs = failedRecipients.map(recipient => ({
    name: 'sms-send',
    data: {
      campaignId,
      shopId: storeId,
      phoneE164: recipient.phoneE164,
      message: campaign.message,
      sender,
    },
  }));

  // Use bulk add for better performance
  const BATCH_SIZE = 1000;
  let totalQueued = 0;

  for (let i = 0; i < retryJobs.length; i += BATCH_SIZE) {
    const batch = retryJobs.slice(i, i + BATCH_SIZE);
    const jobsToAdd = batch.map(job => ({
      name: job.name,
      data: job.data,
    }));

    await smsQueue.addBulk(jobsToAdd);
    totalQueued += batch.length;
  }

  logger.info('Failed SMS queued for retry', {
    storeId,
    campaignId,
    retried: totalQueued,
  });

  return {
    campaignId,
    retried: totalQueued,
    message: `Queued ${totalQueued} failed SMS for retry`,
  };
}

/**
 * Get campaign metrics
 * @param {string} storeId - Store ID
 * @param {string} campaignId - Campaign ID
 * @returns {Promise<Object>} Campaign metrics
 */
export async function getCampaignMetrics(storeId, campaignId) {
  // Return metrics with sent/delivered/failed fields for API compatibility
  logger.info('Getting campaign metrics', { storeId, campaignId });

  const campaign = await prisma.campaign.findFirst({
    where: { id: campaignId, shopId: storeId },
    include: { metrics: true },
  });

  if (!campaign) {
    throw new NotFoundError('Campaign');
  }

  logger.info('Campaign metrics retrieved', { storeId, campaignId });

  const metrics = campaign.metrics || {
    totalSent: 0,
    totalDelivered: 0,
    totalFailed: 0,
    totalClicked: 0,
  };

  // Return with both old and new field names for API compatibility
  return {
    ...metrics,
    sent: metrics.totalSent, // ✅ Add sent alias for test compatibility
    delivered: metrics.totalDelivered, // ✅ Add delivered alias
    failed: metrics.totalFailed, // ✅ Add failed alias
  };
}

/**
 * Get campaign statistics for store
 * @param {string} storeId - Store ID
 * @returns {Promise<Object>} Campaign statistics
 */
export async function getCampaignStats(storeId) {
  logger.info('Getting campaign stats', { storeId });

  const [total, statusStats, recentCampaigns] = await Promise.all([
    prisma.campaign.count({ where: { shopId: storeId } }),
    prisma.campaign.groupBy({
      by: ['status'],
      where: { shopId: storeId },
      _count: { status: true },
    }),
    prisma.campaign.findMany({
      where: { shopId: storeId },
      orderBy: { createdAt: 'desc' },
      take: 5,
      include: { metrics: true },
    }),
  ]);

  const stats = {
    total,
    totalCampaigns: total, // Alias for consistency with expected response structure
    byStatus: {
      draft: statusStats.find(s => s.status === 'draft')?._count?.status || 0,
      scheduled:
        statusStats.find(s => s.status === 'scheduled')?._count?.status || 0,
      sending:
        statusStats.find(s => s.status === 'sending')?._count?.status || 0,
      sent: statusStats.find(s => s.status === 'sent')?._count?.status || 0,
      failed: statusStats.find(s => s.status === 'failed')?._count?.status || 0,
      cancelled:
        statusStats.find(s => s.status === 'cancelled')?._count?.status || 0,
    },
    recent: recentCampaigns,
    recentCampaigns, // Alias for backward compatibility
  };

  logger.info('Campaign stats retrieved', { storeId, stats });

  return stats;
}

export default {
  listCampaigns,
  getCampaignById,
  createCampaign,
  updateCampaign,
  deleteCampaign,
  prepareCampaign,
  sendCampaign,
  scheduleCampaign,
  getCampaignMetrics,
  getCampaignStats,
};
