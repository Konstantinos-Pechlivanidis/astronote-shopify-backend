import prisma from '../services/prisma.js';
import { logger } from '../utils/logger.js';

/**
 * Store Scoping Utilities
 *
 * These utilities ensure all database operations are properly scoped to the current store
 * and prevent cross-tenant data access.
 */

/**
 * Create a store-scoped query builder
 * Automatically injects storeId into all queries
 */
export function withStoreScope(storeId, model) {
  if (!storeId) {
    throw new Error('Store ID is required for scoped operations');
  }

  return {
    // Find many with store scope
    findMany: (args = {}) => {
      const scopedArgs = {
        ...args,
        where: {
          ...args.where,
          shopId: storeId,
        },
      };
      return model.findMany(scopedArgs);
    },

    // Find unique with store scope
    findUnique: args => {
      if (typeof args === 'string') {
        // Handle findUnique({ where: { id: 'xxx' } })
        return model.findUnique({
          where: {
            id: args,
            shopId: storeId,
          },
        });
      }

      const scopedArgs = {
        ...args,
        where: {
          ...args.where,
          shopId: storeId,
        },
      };
      return model.findUnique(scopedArgs);
    },

    // Find first with store scope
    findFirst: (args = {}) => {
      const scopedArgs = {
        ...args,
        where: {
          ...args.where,
          shopId: storeId,
        },
      };
      return model.findFirst(scopedArgs);
    },

    // Create with store scope
    create: args => {
      const scopedArgs = {
        ...args,
        data: {
          ...args.data,
          shopId: storeId,
        },
      };
      return model.create(scopedArgs);
    },

    // Update with store scope
    update: args => {
      const scopedArgs = {
        ...args,
        where: {
          ...args.where,
          shopId: storeId,
        },
      };
      return model.update(scopedArgs);
    },

    // Update many with store scope
    updateMany: args => {
      const scopedArgs = {
        ...args,
        where: {
          ...args.where,
          shopId: storeId,
        },
      };
      return model.updateMany(scopedArgs);
    },

    // Delete with store scope
    delete: args => {
      const scopedArgs = {
        ...args,
        where: {
          ...args.where,
          shopId: storeId,
        },
      };
      return model.delete(scopedArgs);
    },

    // Delete many with store scope
    deleteMany: (args = {}) => {
      const scopedArgs = {
        ...args,
        where: {
          ...args.where,
          shopId: storeId,
        },
      };
      return model.deleteMany(scopedArgs);
    },

    // Count with store scope
    count: (args = {}) => {
      const scopedArgs = {
        ...args,
        where: {
          ...args.where,
          shopId: storeId,
        },
      };
      return model.count(scopedArgs);
    },

    // Aggregate with store scope
    aggregate: (args = {}) => {
      const scopedArgs = {
        ...args,
        where: {
          ...args.where,
          shopId: storeId,
        },
      };
      return model.aggregate(scopedArgs);
    },

    // Group by with store scope
    groupBy: args => {
      const scopedArgs = {
        ...args,
        where: {
          ...args.where,
          shopId: storeId,
        },
      };
      return model.groupBy(scopedArgs);
    },
  };
}

/**
 * Validate that an entity belongs to the current store
 */
export async function validateStoreOwnership(
  storeId,
  model,
  entityId,
  entityName = 'Entity',
) {
  try {
    const entity = await model.findUnique({
      where: { id: entityId },
      select: { shopId: true },
    });

    if (!entity) {
      throw new Error(`${entityName} not found`);
    }

    if (entity.shopId !== storeId) {
      throw new Error(`${entityName} does not belong to the current store`);
    }

    return true;
  } catch (error) {
    logger.error('Store ownership validation failed', {
      storeId,
      entityId,
      entityName,
      error: error.message,
    });
    throw error;
  }
}

/**
 * Validate multiple entities belong to the current store
 */
export async function validateMultipleStoreOwnership(
  storeId,
  model,
  entityIds,
  entityName = 'Entities',
) {
  try {
    const entities = await model.findMany({
      where: {
        id: { in: entityIds },
      },
      select: { id: true, shopId: true },
    });

    const invalidEntities = entities.filter(
      entity => entity.shopId !== storeId,
    );

    if (invalidEntities.length > 0) {
      throw new Error(`Some ${entityName} do not belong to the current store`);
    }

    if (entities.length !== entityIds.length) {
      throw new Error(`Some ${entityName} were not found`);
    }

    return true;
  } catch (error) {
    logger.error('Multiple store ownership validation failed', {
      storeId,
      entityIds,
      entityName,
      error: error.message,
    });
    throw error;
  }
}

/**
 * Create a store-scoped transaction
 */
export async function withStoreTransaction(storeId, callback) {
  if (!storeId) {
    throw new Error('Store ID is required for scoped transactions');
  }

  return await prisma.$transaction(async tx => {
    // Create a scoped transaction context
    const scopedTx = {
      ...tx,
      // Override models to be store-scoped
      contact: withStoreScope(storeId, tx.contact),
      campaign: withStoreScope(storeId, tx.campaign),
      segment: withStoreScope(storeId, tx.segment),
      messageLog: withStoreScope(storeId, tx.messageLog),
      campaignRecipient: withStoreScope(storeId, tx.campaignRecipient),
      userAutomation: withStoreScope(storeId, tx.userAutomation),
      templateUsage: withStoreScope(storeId, tx.templateUsage),
      billingTransaction: withStoreScope(storeId, tx.billingTransaction),
    };

    return await callback(scopedTx);
  });
}

/**
 * Guard against mass operations without store scope
 */
export function guardMassOperations(operation, storeId) {
  if (!storeId) {
    throw new Error('Store ID is required for mass operations');
  }

  // Log mass operations for audit
  logger.info('Mass operation executed', {
    operation,
    storeId,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Create store-scoped rate limiter key
 */
export function getStoreRateLimitKey(storeId, operation) {
  return `store:${storeId}:${operation}`;
}

/**
 * Validate store access for external integrations
 */
export function validateStoreAccess(storeId, integration, operation) {
  if (!storeId) {
    throw new Error(`Store ID is required for ${integration} ${operation}`);
  }

  logger.info('External integration access', {
    storeId,
    integration,
    operation,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Create store-scoped cache key
 */
export function getStoreCacheKey(storeId, key) {
  return `store:${storeId}:${key}`;
}

/**
 * Validate cross-store access attempts
 */
export function validateNoCrossStoreAccess(storeId, targetStoreId, operation) {
  if (storeId !== targetStoreId) {
    logger.warn('Cross-store access attempt blocked', {
      currentStoreId: storeId,
      targetStoreId,
      operation,
      timestamp: new Date().toISOString(),
    });
    throw new Error('Cross-store access is not allowed');
  }
}

export default {
  withStoreScope,
  validateStoreOwnership,
  validateMultipleStoreOwnership,
  withStoreTransaction,
  guardMassOperations,
  getStoreRateLimitKey,
  validateStoreAccess,
  getStoreCacheKey,
  validateNoCrossStoreAccess,
};
