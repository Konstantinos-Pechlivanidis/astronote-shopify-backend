import prisma from './prisma.js';
import { logger } from '../utils/logger.js';
import { ValidationError, NotFoundError } from '../utils/errors.js';

/**
 * Tracking Service
 * Handles message delivery tracking, webhooks, and status updates
 */

/**
 * Track message delivery status
 * @param {string} messageId - Message ID
 * @param {string} status - Delivery status
 * @param {Object} metadata - Additional metadata
 * @param {string} storeId - Optional store ID for security validation (used when called from API)
 * @returns {Promise<Object>} Updated message log
 */
export async function trackMessageStatus(
  messageId,
  status,
  metadata = {},
  storeId = null,
) {
  logger.info('Tracking message status', { messageId, status, storeId });

  // Validate status
  const validStatuses = [
    'queued',
    'sent',
    'delivered',
    'failed',
    'undelivered',
  ];
  if (!validStatuses.includes(status)) {
    throw new ValidationError(
      `Invalid status. Must be one of: ${validStatuses.join(', ')}`,
    );
  }

  // ✅ Security: Find message with optional storeId validation
  const whereClause = { id: messageId };
  if (storeId) {
    whereClause.shopId = storeId; // ✅ Validate message belongs to store if storeId provided
  }

  const message = await prisma.messageLog.findFirst({
    where: whereClause,
  });

  if (!message) {
    throw new NotFoundError('Message');
  }

  // ✅ Security: Update message status (shopId already validated if provided)
  const updated = await prisma.messageLog.update({
    where: { id: messageId },
    data: {
      status,
      deliveredAt: status === 'delivered' ? new Date() : message.deliveredAt,
      failedAt: status === 'failed' ? new Date() : message.failedAt,
      meta: {
        ...message.meta,
        ...metadata,
        statusHistory: [
          ...(message.meta?.statusHistory || []),
          {
            status,
            timestamp: new Date().toISOString(),
            ...metadata,
          },
        ],
      },
    },
  });

  // Update campaign metrics if message is part of a campaign
  if (message.campaignId) {
    await updateCampaignMetrics(message.campaignId, status);
  }

  logger.info('Message status tracked successfully', { messageId, status });

  return updated;
}

/**
 * Update campaign metrics based on message status
 * @param {string} campaignId - Campaign ID
 * @param {string} status - Message status
 */
async function updateCampaignMetrics(campaignId, status) {
  const metrics = await prisma.campaignMetrics.findUnique({
    where: { campaignId },
  });

  if (!metrics) {
    return;
  }

  const updates = {};

  switch (status) {
  case 'sent':
    updates.totalSent = { increment: 1 };
    break;
  case 'delivered':
    updates.totalDelivered = { increment: 1 };
    break;
  case 'failed':
  case 'undelivered':
    updates.totalFailed = { increment: 1 };
    break;
  }

  if (Object.keys(updates).length > 0) {
    await prisma.campaignMetrics.update({
      where: { campaignId },
      data: updates,
    });
  }
}

/**
 * Process delivery webhook from Mitto
 * @param {Object} webhookData - Webhook payload
 * @returns {Promise<Object>} Processing result
 */
export async function processDeliveryWebhook(webhookData) {
  logger.info('Processing delivery webhook', { webhookData });

  const { messageId, status, timestamp, errorCode, errorMessage } = webhookData;

  if (!messageId || !status) {
    throw new ValidationError(
      'Missing required webhook fields: messageId, status',
    );
  }

  const metadata = {
    webhookTimestamp: timestamp,
    errorCode,
    errorMessage,
  };

  try {
    const updated = await trackMessageStatus(messageId, status, metadata);
    logger.info('Webhook processed successfully', { messageId, status });
    return { success: true, message: updated };
  } catch (error) {
    logger.error('Webhook processing failed', {
      error: error.message,
      messageId,
      status,
    });
    throw error;
  }
}

/**
 * Get message tracking details
 * @param {string} storeId - Store ID (for security validation)
 * @param {string} messageId - Message ID
 * @returns {Promise<Object>} Message tracking details
 */
export async function getMessageTracking(storeId, messageId) {
  logger.info('Getting message tracking', { storeId, messageId });

  const message = await prisma.messageLog.findFirst({
    where: {
      id: messageId,
      shopId: storeId, // ✅ Security: Validate message belongs to store
    },
    include: {
      campaign: {
        select: {
          id: true,
          name: true,
        },
      },
    },
  });

  if (!message) {
    throw new NotFoundError('Message');
  }

  logger.info('Message tracking retrieved', { messageId });

  return {
    id: message.id,
    phoneE164: message.phoneE164,
    status: message.status,
    direction: message.direction,
    createdAt: message.createdAt,
    sentAt: message.sentAt,
    deliveredAt: message.deliveredAt,
    failedAt: message.failedAt,
    campaign: message.campaign,
    statusHistory: message.meta?.statusHistory || [],
    errorCode: message.meta?.errorCode,
    errorMessage: message.meta?.errorMessage,
  };
}

/**
 * Get delivery statistics for store
 * @param {string} storeId - Store ID
 * @param {Object} filters - Filter options
 * @returns {Promise<Object>} Delivery statistics
 */
export async function getDeliveryStats(storeId, filters = {}) {
  const { startDate, endDate, campaignId } = filters;

  logger.info('Getting delivery stats', { storeId, filters });

  const where = {
    shopId: storeId,
    direction: 'outbound',
  };

  if (startDate || endDate) {
    where.createdAt = {};
    if (startDate) where.createdAt.gte = new Date(startDate);
    if (endDate) where.createdAt.lte = new Date(endDate);
  }

  if (campaignId) {
    where.campaignId = campaignId;
  }

  const [total, statusBreakdown, deliveryRate] = await Promise.all([
    prisma.messageLog.count({ where }),
    prisma.messageLog.groupBy({
      by: ['status'],
      where,
      _count: { status: true },
    }),
    prisma.messageLog.aggregate({
      where: { ...where, status: { in: ['sent', 'delivered'] } },
      _count: true,
    }),
  ]);

  const stats = {
    total,
    sent: statusBreakdown.find(s => s.status === 'sent')?._count?.status || 0,
    delivered:
      statusBreakdown.find(s => s.status === 'delivered')?._count?.status || 0,
    failed:
      statusBreakdown.find(s => s.status === 'failed')?._count?.status || 0,
    queued:
      statusBreakdown.find(s => s.status === 'queued')?._count?.status || 0,
    deliveryRate: total > 0 ? (deliveryRate._count / total) * 100 : 0,
  };

  logger.info('Delivery stats retrieved', { storeId, stats });

  return stats;
}

/**
 * Get recent message activity for store
 * @param {string} storeId - Store ID
 * @param {number} limit - Number of messages to return
 * @returns {Promise<Array>} Recent messages
 */
export async function getRecentActivity(storeId, limit = 20) {
  logger.info('Getting recent activity', { storeId, limit });

  const messages = await prisma.messageLog.findMany({
    where: { shopId: storeId },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true,
      phoneE164: true,
      status: true,
      direction: true,
      createdAt: true,
      sentAt: true,
      deliveredAt: true,
      campaign: {
        select: {
          id: true,
          name: true,
        },
      },
    },
  });

  logger.info('Recent activity retrieved', { storeId, count: messages.length });

  return messages;
}

/**
 * Get failed messages for store
 * @param {string} storeId - Store ID
 * @param {Object} filters - Filter options
 * @returns {Promise<Object>} Failed messages with pagination
 */
export async function getFailedMessages(storeId, filters = {}) {
  const { page = 1, pageSize = 20, startDate, endDate } = filters;

  logger.info('Getting failed messages', { storeId, filters });

  const where = {
    shopId: storeId,
    status: 'failed',
  };

  if (startDate || endDate) {
    where.createdAt = {};
    if (startDate) where.createdAt.gte = new Date(startDate);
    if (endDate) where.createdAt.lte = new Date(endDate);
  }

  const [messages, total] = await Promise.all([
    prisma.messageLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: parseInt(pageSize),
      skip: (parseInt(page) - 1) * parseInt(pageSize),
      select: {
        id: true,
        phoneE164: true,
        status: true,
        createdAt: true,
        failedAt: true,
        meta: true,
        campaign: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    }),
    prisma.messageLog.count({ where }),
  ]);

  const totalPages = Math.ceil(total / parseInt(pageSize));

  logger.info('Failed messages retrieved', {
    storeId,
    total,
    returned: messages.length,
  });

  return {
    messages,
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

export default {
  trackMessageStatus,
  processDeliveryWebhook,
  getMessageTracking,
  getDeliveryStats,
  getRecentActivity,
  getFailedMessages,
};
