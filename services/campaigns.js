import prisma from './prisma.js';
import { logger } from '../utils/logger.js';
import { ValidationError, NotFoundError } from '../utils/errors.js';
import { InsufficientCreditsError } from './credit-validation.js';
import { smsQueue } from '../queue/index.js';

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
 * Enqueue campaign for bulk SMS sending (new bulk SMS architecture)
 * This function replaces the old sendCampaign logic for bulk campaigns
 * @param {string} storeId - Store ID
 * @param {string} campaignId - Campaign ID
 * @returns {Promise<Object>} Enqueue result
 */
export async function enqueueCampaign(storeId, campaignId) {
  logger.info('Enqueuing campaign for bulk SMS', { storeId, campaignId });

  // 0) Fetch campaign and build audience OUTSIDE transaction (heavy work)
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId, shopId: storeId },
  });

  if (!campaign) {
    return { ok: false, reason: 'not_found', enqueuedJobs: 0 };
  }

  if (!['draft', 'scheduled', 'paused'].includes(campaign.status)) {
    return {
      ok: false,
      reason: `invalid_status:${campaign.status}`,
      enqueuedJobs: 0,
    };
  }

  // Build audience OUTSIDE transaction (this can be slow with many contacts)
  let contacts = [];
  try {
    contacts = await resolveRecipients(storeId, campaign.audience);
  } catch (error) {
    logger.error(
      { storeId, campaignId, error: error.message },
      'Failed to resolve recipients',
    );
    await prisma.campaign.updateMany({
      where: { id: campaign.id, shopId: storeId },
      data: { status: 'failed', updatedAt: new Date() },
    });
    return { ok: false, reason: 'audience_resolution_failed', enqueuedJobs: 0 };
  }

  if (!contacts.length) {
    logger.warn(
      { storeId, campaignId },
      'No eligible recipients found',
    );
    await prisma.campaign.updateMany({
      where: { id: campaign.id, shopId: storeId },
      data: { status: 'failed', updatedAt: new Date() },
    });
    return { ok: false, reason: 'no_recipients', enqueuedJobs: 0 };
  }

  logger.info(
    { storeId, campaignId, recipientCount: contacts.length },
    'Audience built, checking subscription and credits',
  );

  // 1) Check subscription status BEFORE starting any transaction
  const { isSubscriptionActive } = await import('./subscription.js');
  const subscriptionActive = await isSubscriptionActive(storeId);
  if (!subscriptionActive) {
    logger.warn(
      { storeId, campaignId },
      'Inactive subscription - campaign enqueue blocked',
    );
    return { ok: false, reason: 'inactive_subscription', enqueuedJobs: 0 };
  }

  // 2) Check credits BEFORE starting any transaction
  const { getBalance } = await import('./wallet.js');
  const currentBalance = await getBalance(storeId);
  const requiredCredits = contacts.length;

  if (currentBalance < requiredCredits) {
    logger.warn(
      { storeId, campaignId, currentBalance, requiredCredits },
      'Insufficient credits',
    );
    return { ok: false, reason: 'insufficient_credits', enqueuedJobs: 0 };
  }

  // 3) Short transaction: only update campaign status (fast, no heavy work)
  const txResult = await prisma.$transaction(
    async tx => {
      // Double-check status hasn't changed (optimistic locking)
      const currentCamp = await tx.campaign.findUnique({
        where: { id: campaignId },
        select: { status: true, shopId: true },
      });

      if (!currentCamp) {
        return { ok: false, reason: 'not_found' };
      }

      if (!['draft', 'scheduled', 'paused'].includes(currentCamp.status)) {
        return { ok: false, reason: `invalid_status:${currentCamp.status}` };
      }

      // Update status atomically
      const upd = await tx.campaign.updateMany({
        where: {
          id: campaignId,
          status: { in: ['draft', 'scheduled', 'paused'] },
        },
        data: { status: 'sending', updatedAt: new Date() },
      });

      if (upd.count === 0) {
        return { ok: false, reason: 'already_sending' };
      }

      return { ok: true };
    },
    {
      timeout: 5000, // 5 second timeout (should be fast now)
      maxWait: 5000,
    },
  );

  if (!txResult.ok) {
    return { ...txResult, enqueuedJobs: 0 };
  }

  // 4) Create recipient records and prepare messages
  // Note: Credits are NOT debited here - they will be debited per message after successful send
  const messageTemplate = campaign.message;

  if (!messageTemplate || !messageTemplate.trim()) {
    logger.error({ storeId, campaignId }, 'Campaign has no message text');
    await prisma.campaign.updateMany({
      where: { id: campaign.id, shopId: storeId },
      data: { status: 'failed', updatedAt: new Date() },
    });
    return { ok: false, reason: 'no_message_text', enqueuedJobs: 0 };
  }

  // Generate recipient records
  // Note: Message personalization (including discount codes) and unsubscribe links
  // are added in the worker (see queue/jobs/bulkSms.js) to avoid storing
  // full message text in DB
  const recipientsData = contacts.map(contact => {
    // Note: Message personalization and unsubscribe links are added in the worker
    // (see queue/jobs/bulkSms.js) to avoid storing full message text in DB
    return {
      campaignId: campaign.id,
      contactId: contact.contactId,
      phoneE164: contact.phoneE164,
      status: 'pending', // Will be updated to 'sent' or 'failed' by worker
      retryCount: 0,
    };
  });

  try {
    // For large campaigns (>10k recipients), batch the createMany operation
    const BATCH_SIZE = 10000;
    const recipientCount = recipientsData.length;

    if (recipientCount > BATCH_SIZE) {
      logger.info(
        { storeId, campaignId, recipientCount },
        'Large campaign detected, using batched inserts',
      );

      // Batch create recipients
      for (let i = 0; i < recipientsData.length; i += BATCH_SIZE) {
        const batch = recipientsData.slice(i, i + BATCH_SIZE);
        await prisma.campaignRecipient.createMany({
          data: batch,
          skipDuplicates: true,
        });
        logger.debug(
          {
            storeId,
            campaignId,
            batch: Math.floor(i / BATCH_SIZE) + 1,
            totalBatches: Math.ceil(recipientCount / BATCH_SIZE),
          },
          'Batch inserted',
        );
      }
    } else {
      // For smaller campaigns, use single createMany
      await prisma.campaignRecipient.createMany({
        data: recipientsData,
        skipDuplicates: true,
      });
    }
  } catch (e) {
    logger.error(
      { storeId, campaignId, err: e.message, contactCount: contacts.length },
      'Failed to create campaign recipients',
    );
    // Revert campaign status
    await prisma.campaign.updateMany({
      where: { id: campaign.id, shopId: storeId },
      data: { status: 'draft', updatedAt: new Date() },
    });
    throw e;
  }

  // 5) Enqueue jobs to Redis (OUTSIDE transaction, non-blocking)
  // Campaigns always use bulk SMS with fixed batch size
  const toEnqueue = await prisma.campaignRecipient.findMany({
    where: {
      campaignId: campaign.id,
      status: 'pending',
      mittoMessageId: null, // Idempotency: only process unsent
    },
    select: { id: true },
  });

  let enqueuedJobs = 0;
  if (smsQueue && toEnqueue.length > 0) {
    // Fixed batch size for bulk SMS
    const SMS_BATCH_SIZE = Number(process.env.SMS_BATCH_SIZE || 5000);

    // Group recipients into fixed-size batches
    const batches = [];
    for (let i = 0; i < toEnqueue.length; i += SMS_BATCH_SIZE) {
      batches.push(toEnqueue.slice(i, i + SMS_BATCH_SIZE).map(r => r.id));
    }

    logger.info(
      {
        storeId,
        campaignId,
        totalRecipients: toEnqueue.length,
        batchCount: batches.length,
        batchSize: SMS_BATCH_SIZE,
      },
      'Enqueuing bulk SMS batch jobs',
    );

    // Enqueue batch jobs
    const enqueuePromises = batches.map((recipientIds, batchIndex) =>
      smsQueue
        .add(
          'sendBulkSMS',
          {
            campaignId: campaign.id,
            shopId: storeId,
            recipientIds,
          },
          {
            jobId: `batch:${campaign.id}:${Date.now()}:${batchIndex}`,
            attempts: 5,
            backoff: { type: 'exponential', delay: 3000 },
          },
        )
        .then(() => {
          enqueuedJobs += recipientIds.length;
          logger.debug(
            { storeId, campaignId, batchIndex, recipientCount: recipientIds.length },
            'Batch job enqueued',
          );
        })
        .catch(err => {
          logger.error(
            { storeId, campaignId, batchIndex, err: err.message },
            'Failed to enqueue batch job',
          );
          // Continue even if some batches fail to enqueue
        }),
    );

    // Wait for initial batches (first 10) to ensure some jobs are enqueued
    try {
      await Promise.all(
        enqueuePromises.slice(0, Math.min(10, enqueuePromises.length)),
      );
    } catch (err) {
      logger.error(
        { storeId, campaignId, err: err.message },
        'Some batch jobs failed to enqueue initially',
      );
    }

    // Continue enqueuing remaining batches in background (fire and forget)
    if (enqueuePromises.length > 10) {
      Promise.all(enqueuePromises.slice(10)).catch(err => {
        logger.error(
          { storeId, campaignId, err: err.message },
          'Some background batch jobs failed to enqueue',
        );
      });
    }
  } else {
    logger.warn(
      'SMS queue not available — recipients created but not enqueued',
    );
  }

  logger.info(
    {
      storeId,
      campaignId,
      created: recipientsData.length,
      enqueuedJobs,
    },
    'Campaign enqueued successfully',
  );

  return {
    ok: true,
    created: recipientsData.length,
    enqueuedJobs,
    campaignId: campaign.id,
  };
}

/**
 * Send campaign immediately (now uses bulk SMS via enqueueCampaign)
 * @param {string} storeId - Store ID
 * @param {string} campaignId - Campaign ID
 * @returns {Promise<Object>} Send result
 */
export async function sendCampaign(storeId, campaignId) {
  logger.info('Sending campaign (bulk SMS)', { storeId, campaignId });

  // Use new bulk SMS enqueue function
  const result = await enqueueCampaign(storeId, campaignId);

  if (!result.ok) {
    // Map error reasons to appropriate errors
    if (result.reason === 'not_found') {
      throw new NotFoundError('Campaign');
    }
    if (result.reason === 'inactive_subscription') {
      throw new ValidationError(
        'Active subscription required to send SMS. Please subscribe to a plan.',
      );
    }
    if (result.reason === 'insufficient_credits') {
      throw new InsufficientCreditsError(0, 0); // Will be handled by caller
    }
    throw new ValidationError(
      `Campaign cannot be sent: ${result.reason}`,
    );
  }

  return {
    campaignId: result.campaignId,
    recipientCount: result.created,
    status: 'sending',
    queuedAt: new Date(),
  };
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
