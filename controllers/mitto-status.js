// controllers/mitto-status.js
// Controllers for on-demand Mitto status refresh (debugging/UI)

import { getStoreId } from '../middlewares/store-resolution.js';
import { logger } from '../utils/logger.js';
import { sendSuccess } from '../utils/response.js';
import {
  refreshMessageStatus,
  refreshMessageStatusBulk,
} from '../services/mitto-status.js';

/**
 * Refresh single message status from Mitto
 * @route POST /api/mitto/refresh-status
 */
export async function refreshStatus(req, res, next) {
  try {
    const shopId = getStoreId(req); // Optional - for scoping
    const { providerMessageId } = req.body || {};

    if (!providerMessageId) {
      return res.status(400).json({
        ok: false,
        message: 'Provider message ID is required',
        code: 'VALIDATION_ERROR',
      });
    }

    const result = await refreshMessageStatus(providerMessageId, shopId);

    return sendSuccess(res, result, 'Message status refreshed successfully');
  } catch (error) {
    if (error.message.includes('not found')) {
      return res.status(404).json({
        ok: false,
        message: error.message || 'Message not found',
        code: 'MESSAGE_NOT_FOUND',
      });
    }

    logger.error('Refresh message status error', {
      error: error.message,
      stack: error.stack,
      storeId: getStoreId(req),
      providerMessageId: req.body?.providerMessageId,
      requestId: req.id,
      path: req.path,
      method: req.method,
    });
    next(error);
  }
}

/**
 * Refresh status for multiple messages (bulk)
 * @route POST /api/mitto/refresh-status-bulk
 */
export async function refreshStatusBulk(req, res, next) {
  try {
    const shopId = getStoreId(req); // Optional - for scoping
    const { providerMessageIds, campaignId } = req.body || {};
    const prisma = (await import('../services/prisma.js')).default;

    let messageIds = [];

    if (campaignId) {
      // Get all messageIds for campaign that have mittoMessageId
      const recipients = await prisma.campaignRecipient.findMany({
        where: {
          campaignId,
          shopId, // Security: ensure campaign belongs to shop
          mittoMessageId: { not: null },
        },
        select: { mittoMessageId: true },
      });
      messageIds = recipients
        .map((r) => r.mittoMessageId)
        .filter(Boolean);
    } else if (Array.isArray(providerMessageIds) && providerMessageIds.length > 0) {
      messageIds = providerMessageIds.filter(Boolean);
    } else {
      return res.status(400).json({
        ok: false,
        message:
          'Either campaignId or providerMessageIds array is required',
        code: 'VALIDATION_ERROR',
      });
    }

    if (messageIds.length === 0) {
      return sendSuccess(res, {
        total: 0,
        updated: 0,
        failed: 0,
        results: [],
      });
    }

    const result = await refreshMessageStatusBulk(messageIds, shopId, 100);

    return sendSuccess(res, result, 'Bulk status refresh completed');
  } catch (error) {
    logger.error('Refresh status bulk error', {
      error: error.message,
      stack: error.stack,
      storeId: getStoreId(req),
      body: req.body,
      requestId: req.id,
      path: req.path,
      method: req.method,
    });
    next(error);
  }
}

/**
 * Get message status from Mitto (read-only, no update)
 * @route GET /api/mitto/message/:messageId
 */
export async function getStatus(req, res, next) {
  try {
    const { messageId } = req.params;
    if (!messageId) {
      return res.status(400).json({
        ok: false,
        message: 'Message ID is required',
        code: 'VALIDATION_ERROR',
      });
    }

    const { getMessageStatus } = await import('../services/mitto.js');
    const status = await getMessageStatus(messageId);

    return sendSuccess(res, status);
  } catch (error) {
    if (error.message?.includes('not found') || error.status === 404) {
      return res.status(404).json({
        ok: false,
        message: error.message || 'Message not found',
        code: 'MESSAGE_NOT_FOUND',
      });
    }

    logger.error('Get message status error', {
      error: error.message,
      stack: error.stack,
      messageId: req.params.messageId,
      requestId: req.id,
      path: req.path,
      method: req.method,
    });
    next(error);
  }
}

export default {
  refreshStatus,
  refreshStatusBulk,
  getStatus,
};

