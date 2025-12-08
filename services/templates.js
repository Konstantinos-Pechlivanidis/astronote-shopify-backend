import prisma from './prisma.js';
import { logger } from '../utils/logger.js';
import { NotFoundError } from '../utils/errors.js';

/**
 * Templates Service
 * Handles template management and usage tracking
 */

/**
 * List public templates with filtering
 * @param {Object} filters - Filter options
 * @returns {Promise<Object>} Templates list with pagination
 */
export async function listTemplates(filters = {}) {
  const { category, search, page = 1, pageSize = 50 } = filters;

  logger.info('Listing templates', { filters });

  // Build where clause
  const where = { isPublic: true };

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

  // Execute query
  const [templates, total, categories] = await Promise.all([
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
      take: parseInt(pageSize),
      skip: (parseInt(page) - 1) * parseInt(pageSize),
    }),
    prisma.template.count({ where }),
    prisma.template.findMany({
      where: { isPublic: true },
      select: { category: true },
      distinct: ['category'],
    }),
  ]);

  const totalPages = Math.ceil(total / parseInt(pageSize));

  logger.info('Templates listed successfully', {
    total,
    returned: templates.length,
  });

  return {
    templates,
    pagination: {
      page: parseInt(page),
      pageSize: parseInt(pageSize),
      total,
      totalPages,
      hasNextPage: parseInt(page) < totalPages,
      hasPrevPage: parseInt(page) > 1,
    },
    categories: categories.map(c => c.category),
  };
}

/**
 * Get template by ID
 * @param {string} templateId - Template ID
 * @returns {Promise<Object>} Template data
 */
export async function getTemplateById(templateId) {
  logger.info('Getting template by ID', { templateId });

  const template = await prisma.template.findFirst({
    where: {
      id: templateId,
      isPublic: true,
    },
  });

  if (!template) {
    throw new NotFoundError('Template');
  }

  logger.info('Template retrieved successfully', { templateId });

  return template;
}

/**
 * Track template usage
 * @param {string} storeId - Store ID
 * @param {string} templateId - Template ID
 * @returns {Promise<Object>} Usage record
 */
export async function trackTemplateUsage(storeId, templateId) {
  logger.info('Tracking template usage', { storeId, templateId });

  // Verify template exists
  const template = await prisma.template.findUnique({
    where: { id: templateId },
  });

  if (!template) {
    throw new NotFoundError('Template');
  }

  // Create usage record
  const usage = await prisma.templateUsage.create({
    data: {
      shopId: storeId,
      templateId,
    },
  });

  logger.info('Template usage tracked', {
    storeId,
    templateId,
    usageId: usage.id,
  });

  return usage;
}

/**
 * Get template usage statistics for store
 * @param {string} storeId - Store ID
 * @returns {Promise<Object>} Usage statistics
 */
export async function getTemplateUsageStats(storeId) {
  logger.info('Getting template usage stats', { storeId });

  const [totalUsage, recentUsage, topTemplates] = await Promise.all([
    prisma.templateUsage.count({
      where: { shopId: storeId },
    }),
    prisma.templateUsage.findMany({
      where: { shopId: storeId },
      orderBy: { createdAt: 'desc' },
      take: 10,
      include: {
        template: {
          select: {
            id: true,
            title: true,
            category: true,
          },
        },
      },
    }),
    prisma.templateUsage.groupBy({
      by: ['templateId'],
      where: { shopId: storeId },
      _count: { templateId: true },
      orderBy: { _count: { templateId: 'desc' } },
      take: 5,
    }),
  ]);

  // Get template details for top templates
  const topTemplateIds = topTemplates.map(t => t.templateId);
  const templateDetails = await prisma.template.findMany({
    where: { id: { in: topTemplateIds } },
    select: { id: true, title: true, category: true },
  });

  const topTemplatesWithDetails = topTemplates.map(t => ({
    template: templateDetails.find(td => td.id === t.templateId),
    usageCount: t._count.templateId,
  }));

  logger.info('Template usage stats retrieved', { storeId, totalUsage });

  return {
    totalUsage,
    recentUsage,
    topTemplates: topTemplatesWithDetails,
  };
}

/**
 * Get popular templates (most used across all stores)
 * @param {number} limit - Number of templates to return
 * @returns {Promise<Array>} Popular templates
 */
export async function getPopularTemplates(limit = 10) {
  logger.info('Getting popular templates', { limit });

  const popularUsage = await prisma.templateUsage.groupBy({
    by: ['templateId'],
    _count: { templateId: true },
    orderBy: { _count: { templateId: 'desc' } },
    take: limit,
  });

  const templateIds = popularUsage.map(u => u.templateId);
  const templates = await prisma.template.findMany({
    where: { id: { in: templateIds }, isPublic: true },
    select: {
      id: true,
      title: true,
      category: true,
      content: true,
      previewImage: true,
      tags: true,
    },
  });

  const popularTemplates = popularUsage.map(u => ({
    ...templates.find(t => t.id === u.templateId),
    usageCount: u._count.templateId,
  }));

  logger.info('Popular templates retrieved', {
    count: popularTemplates.length,
  });

  return popularTemplates;
}

export default {
  listTemplates,
  getTemplateById,
  trackTemplateUsage,
  getTemplateUsageStats,
  getPopularTemplates,
};
