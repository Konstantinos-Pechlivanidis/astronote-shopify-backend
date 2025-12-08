import prisma from '../services/prisma.js';
import { logger } from '../utils/logger.js';
import { getStoreId } from '../middlewares/store-resolution.js';
import { sendSuccess, sendCreated } from '../utils/response.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';

/**
 * Create a new user automation
 * @route POST /automations
 */
export async function createUserAutomation(req, res, next) {
  try {
    const shopId = getStoreId(req);
    const { name, trigger, message, status } = req.body;

    // Validate required fields
    if (!name || !name.trim()) {
      throw new ValidationError('Automation name is required');
    }

    if (!trigger) {
      throw new ValidationError('Trigger is required');
    }

    if (!message || !message.trim()) {
      throw new ValidationError('Message is required');
    }

    // Validate trigger is a valid AutomationTrigger enum value
    const validTriggers = [
      'welcome',
      'abandoned_cart',
      'order_confirmation',
      'shipping_update',
      'delivery_confirmation',
      'review_request',
      'reorder_reminder',
      'birthday',
      'customer_inactive',
      'cart_abandoned',
      'order_placed',
      'order_fulfilled', // Added
    ];

    if (!validTriggers.includes(trigger)) {
      throw new ValidationError(
        `Invalid trigger. Must be one of: ${validTriggers.join(', ')}`,
      );
    }

    // Validate status if provided
    if (status && !['draft', 'active'].includes(status)) {
      throw new ValidationError('Status must be either "draft" or "active"');
    }

    // Create custom automation (not system default)
    const automation = await prisma.automation.create({
      data: {
        title: name.trim(),
        description: `Custom automation for ${trigger}`,
        triggerEvent: trigger,
        defaultMessage: message.trim(),
        isSystemDefault: false,
      },
    });

    // Create user automation linking shop to the automation
    const userAutomation = await prisma.userAutomation.create({
      data: {
        shopId,
        automationId: automation.id,
        userMessage: message.trim(), // Store custom message
        isActive: status === 'active' || status === undefined, // Default to active if not specified
      },
      include: {
        automation: {
          select: {
            id: true,
            title: true,
            description: true,
            triggerEvent: true,
            defaultMessage: true,
            isSystemDefault: true,
          },
        },
      },
    });

    logger.info('User automation created', {
      userAutomationId: userAutomation.id,
      shopId,
      automationId: automation.id,
      trigger,
    });

    return sendCreated(
      res,
      {
        id: userAutomation.id,
        automationId: userAutomation.automationId,
        name: userAutomation.automation.title,
        trigger: userAutomation.automation.triggerEvent,
        message: userAutomation.userMessage,
        status: userAutomation.isActive ? 'active' : 'draft',
        isSystemDefault: userAutomation.automation.isSystemDefault,
        createdAt: userAutomation.createdAt,
        updatedAt: userAutomation.updatedAt,
      },
      'Automation created successfully',
    );
  } catch (error) {
    logger.error('Failed to create user automation', {
      error: error.message,
      stack: error.stack,
      shopId: req.ctx?.store?.id,
      body: req.body,
    });
    next(error);
  }
}

/**
 * Get all automations for the current user
 */
export async function getUserAutomations(req, res, next) {
  try {
    // ✅ Security: Get storeId from context
    const shopId = getStoreId(req);

    const userAutomations = await prisma.userAutomation.findMany({
      where: { shopId },
      include: {
        automation: {
          select: {
            id: true,
            title: true,
            description: true,
            triggerEvent: true,
            defaultMessage: true,
            isSystemDefault: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    // Transform the data to frontend-friendly format
    const automations = userAutomations.map(userAutomation => ({
      id: userAutomation.id,
      automationId: userAutomation.automationId,
      name: userAutomation.automation.title,
      description: userAutomation.automation.description,
      trigger: userAutomation.automation.triggerEvent,
      message:
        userAutomation.userMessage || userAutomation.automation.defaultMessage,
      status: userAutomation.isActive ? 'active' : 'draft',
      isSystemDefault: userAutomation.automation.isSystemDefault,
      createdAt: userAutomation.createdAt,
      updatedAt: userAutomation.updatedAt,
      // Include backend fields for backward compatibility if needed
      title: userAutomation.automation.title,
      triggerEvent: userAutomation.automation.triggerEvent,
      userMessage: userAutomation.userMessage,
      isActive: userAutomation.isActive,
    }));

    return sendSuccess(res, automations);
  } catch (error) {
    logger.error('Failed to fetch user automations', {
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
 * Update user automation (message content or active status)
 */
export async function updateUserAutomation(req, res, next) {
  try {
    const { id } = req.params;
    // Accept both frontend-friendly format and backend format
    const { userMessage, isActive, message, status } = req.body;

    // ✅ Security: Get storeId from context
    const shopId = getStoreId(req);

    // Transform frontend format to backend format
    let finalUserMessage = userMessage;
    let finalIsActive = isActive;

    // If frontend sends 'message' and 'status', transform them
    if (message !== undefined) {
      finalUserMessage = message;
    }
    if (status !== undefined) {
      // Convert status string to boolean
      if (status === 'active' || status === 'paused') {
        finalIsActive = status === 'active';
      } else if (status === 'draft') {
        finalIsActive = false;
      }
      // If status is already a boolean, use it as is
    }

    // Check if the user automation exists and belongs to the shop
    const existingUserAutomation = await prisma.userAutomation.findFirst({
      where: {
        id,
        shopId,
      },
      include: {
        automation: true,
      },
    });

    if (!existingUserAutomation) {
      throw new NotFoundError('Automation');
    }

    // Update the user automation
    const updatedUserAutomation = await prisma.userAutomation.update({
      where: { id },
      data: {
        ...(finalUserMessage !== undefined && {
          userMessage: finalUserMessage,
        }),
        ...(finalIsActive !== undefined && { isActive: finalIsActive }),
      },
      include: {
        automation: {
          select: {
            id: true,
            title: true,
            description: true,
            triggerEvent: true,
            defaultMessage: true,
            isSystemDefault: true,
          },
        },
      },
    });

    logger.info('User automation updated', {
      userAutomationId: id,
      shopId,
      changes: { userMessage: finalUserMessage, isActive: finalIsActive },
    });

    // Return in frontend-friendly format
    return sendSuccess(
      res,
      {
        id: updatedUserAutomation.id,
        automationId: updatedUserAutomation.automationId,
        name: updatedUserAutomation.automation.title,
        description: updatedUserAutomation.automation.description,
        trigger: updatedUserAutomation.automation.triggerEvent,
        message:
          updatedUserAutomation.userMessage ||
          updatedUserAutomation.automation.defaultMessage,
        status: updatedUserAutomation.isActive ? 'active' : 'draft',
        isSystemDefault: updatedUserAutomation.automation.isSystemDefault,
        createdAt: updatedUserAutomation.createdAt,
        updatedAt: updatedUserAutomation.updatedAt,
        // Include backend fields for backward compatibility
        title: updatedUserAutomation.automation.title,
        triggerEvent: updatedUserAutomation.automation.triggerEvent,
        userMessage: updatedUserAutomation.userMessage,
        isActive: updatedUserAutomation.isActive,
      },
      'Automation updated successfully',
    );
  } catch (error) {
    logger.error('Failed to update user automation', {
      error: error.message,
      stack: error.stack,
      userAutomationId: req.params.id,
      shopId: getStoreId(req),
      requestId: req.id,
      path: req.path,
      method: req.method,
      body: req.body,
    });
    next(error);
  }
}

/**
 * Get system default automations (admin only)
 */
export async function getSystemDefaults(req, res, next) {
  try {
    const systemAutomations = await prisma.automation.findMany({
      where: { isSystemDefault: true },
      select: {
        id: true,
        title: true,
        description: true,
        triggerEvent: true,
        defaultMessage: true,
        isSystemDefault: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    return sendSuccess(res, systemAutomations);
  } catch (error) {
    logger.error('Failed to fetch system default automations', {
      error: error.message,
      stack: error.stack,
      requestId: req.id,
      path: req.path,
      method: req.method,
    });
    next(error);
  }
}

/**
 * Sync new system defaults to all users (admin only)
 */
export async function syncSystemDefaults(req, res, next) {
  try {
    // Get all shops
    const shops = await prisma.shop.findMany({
      select: { id: true, shopDomain: true },
    });

    // Get all system default automations
    const systemAutomations = await prisma.automation.findMany({
      where: { isSystemDefault: true },
    });

    let syncedCount = 0;

    // For each shop, ensure they have all system automations
    for (const shop of shops) {
      for (const systemAutomation of systemAutomations) {
        // Check if user automation already exists
        const existingUserAutomation = await prisma.userAutomation.findUnique({
          where: {
            shopId_automationId: {
              shopId: shop.id,
              automationId: systemAutomation.id,
            },
          },
        });

        // Create user automation if it doesn't exist
        if (!existingUserAutomation) {
          await prisma.userAutomation.create({
            data: {
              shopId: shop.id,
              automationId: systemAutomation.id,
              isActive: true, // Default to active
            },
          });
          syncedCount++;
        }
      }
    }

    logger.info('System defaults synced to all users', {
      syncedCount,
      totalShops: shops.length,
      totalAutomations: systemAutomations.length,
    });

    return sendSuccess(
      res,
      {
        syncedCount,
        totalShops: shops.length,
        totalAutomations: systemAutomations.length,
      },
      `Successfully synced ${syncedCount} new automations to all users`,
    );
  } catch (error) {
    logger.error('Failed to sync system defaults', {
      error: error.message,
      stack: error.stack,
      requestId: req.id,
      path: req.path,
      method: req.method,
    });
    next(error);
  }
}

/**
 * Delete user automation
 * @route DELETE /automations/:id
 */
export async function deleteUserAutomation(req, res, next) {
  try {
    const { id } = req.params;
    // ✅ Security: Get storeId from context
    const shopId = getStoreId(req);

    // Check if the user automation exists and belongs to the shop
    const existingUserAutomation = await prisma.userAutomation.findFirst({
      where: {
        id,
        shopId,
      },
      include: {
        automation: true,
      },
    });

    if (!existingUserAutomation) {
      throw new NotFoundError('Automation');
    }

    // Don't allow deletion of system default automations
    if (existingUserAutomation.automation.isSystemDefault) {
      throw new ValidationError('Cannot delete system default automation');
    }

    // Delete the user automation
    await prisma.userAutomation.delete({
      where: { id },
    });

    logger.info('User automation deleted', {
      userAutomationId: id,
      shopId,
      automationId: existingUserAutomation.automationId,
    });

    return sendSuccess(res, null, 'Automation deleted successfully');
  } catch (error) {
    logger.error('Failed to delete user automation', {
      error: error.message,
      stack: error.stack,
      userAutomationId: req.params.id,
      shopId: getStoreId(req),
      requestId: req.id,
      path: req.path,
      method: req.method,
    });
    next(error);
  }
}

/**
 * Get automation statistics for a user
 */
export async function getAutomationStats(req, res, next) {
  try {
    // ✅ Security: Get storeId from context
    const shopId = getStoreId(req);

    const [total, enabled, disabled] = await Promise.all([
      prisma.userAutomation.count({
        where: { shopId },
      }),
      prisma.userAutomation.count({
        where: { shopId, isActive: true },
      }),
      prisma.userAutomation.count({
        where: { shopId, isActive: false },
      }),
    ]);

    // Get total messages sent by automations
    const totalSent = await prisma.messageLog.count({
      where: {
        shopId,
        campaignId: null, // Automation messages don't have campaignId
      },
    });

    return sendSuccess(res, {
      total,
      enabled,
      disabled,
      totalSent,
    });
  } catch (error) {
    logger.error('Failed to fetch automation statistics', {
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

export default {
  createUserAutomation,
  getUserAutomations,
  updateUserAutomation,
  deleteUserAutomation,
  getSystemDefaults,
  syncSystemDefaults,
  getAutomationStats,
};
