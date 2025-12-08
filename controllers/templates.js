import prisma from '../services/prisma.js';
import { logger } from '../utils/logger.js';
import { getStoreId } from '../middlewares/store-resolution.js';
import { sendSuccess, sendPaginated } from '../utils/response.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';

/**
 * Get all public templates with optional category filter
 */
export async function getAllTemplates(req, res, next) {
  try {
    const { category, search, limit = 50, offset = 0 } = req.query;

    // Build where clause for filtering
    const where = {
      isPublic: true,
    };

    if (category) {
      where.category = category;
    }

    if (search) {
      where.OR = [
        { title: { contains: search, mode: 'insensitive' } },
        { content: { contains: search, mode: 'insensitive' } },
        { tags: { has: search } },
      ];
    }

    // Get storeId for usage tracking (optional)
    let shopId = null;
    try {
      shopId = getStoreId(req);
    } catch (error) {
      // Not authenticated or no store context - templates still available
      shopId = null;
    }

    // Get templates with pagination
    const [templates, total] = await Promise.all([
      prisma.template.findMany({
        where,
        select: {
          id: true,
          title: true,
          category: true,
          content: true,
          previewImage: true,
          tags: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: { createdAt: 'desc' },
        take: parseInt(limit),
        skip: parseInt(offset),
      }),
      prisma.template.count({ where }),
    ]);

    // Get usage counts for each template if shopId is available
    const usageCounts = {};
    if (shopId) {
      const templateIds = templates.map(t => t.id);
      const usages = await prisma.templateUsage.findMany({
        where: {
          shopId,
          templateId: { in: templateIds },
        },
        select: {
          templateId: true,
          usedCount: true,
        },
      });
      usages.forEach(usage => {
        usageCounts[usage.templateId] = usage.usedCount;
      });
    }

    // Add usage counts to templates
    const templatesWithUsage = templates.map(template => ({
      ...template,
      useCount: usageCounts[template.id] || 0,
    }));

    // Get unique categories for filter options
    const categories = await prisma.template.findMany({
      where: { isPublic: true },
      select: { category: true },
      distinct: ['category'],
    });

    // Convert offset/limit to page/pageSize for standardization
    const page = Math.floor(parseInt(offset) / parseInt(limit)) + 1;
    const pageSize = parseInt(limit);
    const totalPages = Math.ceil(total / pageSize);

    return sendPaginated(
      res,
      templatesWithUsage,
      {
        page,
        pageSize,
        total,
        totalPages,
        hasNextPage: parseInt(offset) + parseInt(limit) < total,
        hasPrevPage: parseInt(offset) > 0,
      },
      {
        templates: templatesWithUsage, // Include templates array with usage counts
        categories: categories.map(c => c.category),
      },
    );
  } catch (error) {
    logger.error('Failed to fetch templates', {
      error: error.message,
      stack: error.stack,
      query: req.query,
      requestId: req.id,
      path: req.path,
      method: req.method,
    });
    next(error);
  }
}

/**
 * Get a single template by ID
 */
export async function getTemplateById(req, res, next) {
  try {
    const { id } = req.params;

    const template = await prisma.template.findFirst({
      where: {
        id,
        isPublic: true,
      },
      select: {
        id: true,
        title: true,
        category: true,
        content: true,
        previewImage: true,
        tags: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!template) {
      throw new NotFoundError('Template');
    }

    return sendSuccess(res, template);
  } catch (error) {
    logger.error('Failed to fetch template', {
      error: error.message,
      stack: error.stack,
      templateId: req.params.id,
      requestId: req.id,
      path: req.path,
      method: req.method,
    });
    next(error);
  }
}

/**
 * Get template categories
 */
export async function getTemplateCategories(req, res, next) {
  try {
    const categories = await prisma.template.findMany({
      where: { isPublic: true },
      select: { category: true },
      distinct: ['category'],
      orderBy: { category: 'asc' },
    });

    return sendSuccess(
      res,
      categories.map(c => c.category),
    );
  } catch (error) {
    logger.error('Failed to fetch template categories', {
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
 * Track template usage (for analytics)
 */
export async function trackTemplateUsage(req, res, next) {
  try {
    const { templateId } = req.params;

    // ✅ Security: Get storeId from context (preferred) or fallback to req.shop
    let shopId = null;
    try {
      shopId = getStoreId(req); // ✅ Use store context if available
    } catch (error) {
      // Fallback for legacy support
      shopId = req.shop?.shopId || req.shop?.id;
    }

    if (!shopId) {
      throw new ValidationError(
        'Shop context is required to track template usage. Please ensure you are properly authenticated.',
      );
    }

    // Check if template exists and is public
    const template = await prisma.template.findFirst({
      where: {
        id: templateId,
        isPublic: true,
      },
    });

    if (!template) {
      throw new NotFoundError('Template');
    }

    // Upsert template usage record
    await prisma.templateUsage.upsert({
      where: {
        shopId_templateId: {
          shopId,
          templateId,
        },
      },
      update: {
        usedCount: { increment: 1 },
        lastUsedAt: new Date(),
      },
      create: {
        shopId,
        templateId,
        usedCount: 1,
        lastUsedAt: new Date(),
      },
    });

    return sendSuccess(res, null, 'Template usage tracked');
  } catch (error) {
    logger.error('Failed to track template usage', {
      error: error.message,
      stack: error.stack,
      templateId: req.params.templateId,
      shopId: req.shop?.id,
      requestId: req.id,
      path: req.path,
      method: req.method,
    });
    next(error);
  }
}

export default {
  getAllTemplates,
  getTemplateById,
  getTemplateCategories,
  trackTemplateUsage,
};
