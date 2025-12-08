import prisma from '../services/prisma.js';
import { logger } from '../utils/logger.js';
import { sendSuccess, sendCreated, sendPaginated } from '../utils/response.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';

/**
 * Create a new template (admin only)
 */
export async function createTemplate(req, res, _next) {
  try {
    const { title, category, content, previewImage, tags = [] } = req.body;

    // Validate required fields
    if (!title || !category || !content) {
      throw new ValidationError('Title, category, and content are required');
    }

    const template = await prisma.template.create({
      data: {
        title,
        category,
        content,
        previewImage,
        tags,
        isPublic: true, // Templates are public by default
      },
    });

    logger.info('Template created', {
      templateId: template.id,
      title: template.title,
      category: template.category,
    });

    return sendCreated(res, template, 'Template created successfully');
  } catch (error) {
    logger.error('Failed to create template', {
      error: error.message,
      body: req.body,
    });
    throw error;
  }
}

/**
 * Update a template (admin only)
 */
export async function updateTemplate(req, res, _next) {
  try {
    const { id } = req.params;
    const { title, category, content, previewImage, tags, isPublic } = req.body;

    // Check if template exists
    const existingTemplate = await prisma.template.findUnique({
      where: { id },
    });

    if (!existingTemplate) {
      throw new NotFoundError('Template');
    }

    const template = await prisma.template.update({
      where: { id },
      data: {
        ...(title !== undefined && { title }),
        ...(category !== undefined && { category }),
        ...(content !== undefined && { content }),
        ...(previewImage !== undefined && { previewImage }),
        ...(tags !== undefined && { tags }),
        ...(isPublic !== undefined && { isPublic }),
      },
    });

    logger.info('Template updated', {
      templateId: template.id,
      title: template.title,
      category: template.category,
    });

    return sendSuccess(res, template, 'Template updated successfully');
  } catch (error) {
    logger.error('Failed to update template', {
      error: error.message,
      templateId: req.params.id,
      body: req.body,
    });
    throw error;
  }
}

/**
 * Delete a template (admin only)
 */
export async function deleteTemplate(req, res, _next) {
  try {
    const { id } = req.params;

    // Check if template exists
    const existingTemplate = await prisma.template.findUnique({
      where: { id },
    });

    if (!existingTemplate) {
      throw new NotFoundError('Template');
    }

    // Delete template (cascade will handle related records)
    await prisma.template.delete({
      where: { id },
    });

    logger.info('Template deleted', {
      templateId: id,
      title: existingTemplate.title,
    });

    return sendSuccess(res, null, 'Template deleted successfully');
  } catch (error) {
    logger.error('Failed to delete template', {
      error: error.message,
      templateId: req.params.id,
    });
    throw error;
  }
}

/**
 * Get all templates (including private ones) for admin management
 */
export async function getAllTemplatesAdmin(req, res, _next) {
  try {
    const { category, search, limit = 50, offset = 0 } = req.query;

    // Build where clause for filtering
    const where = {};

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

    // Get templates with pagination
    const [templates, total] = await Promise.all([
      prisma.template.findMany({
        where,
        include: {
          usage: {
            select: {
              shopId: true,
              usedCount: true,
              lastUsedAt: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: parseInt(limit),
        skip: parseInt(offset),
      }),
      prisma.template.count({ where }),
    ]);

    // Convert offset/limit to page/pageSize for standardization
    const page = Math.floor(parseInt(offset) / parseInt(limit)) + 1;
    const pageSize = parseInt(limit);
    const totalPages = Math.ceil(total / pageSize);

    return sendPaginated(res, templates, {
      page,
      pageSize,
      total,
      totalPages,
      hasNextPage: parseInt(offset) + parseInt(limit) < total,
      hasPrevPage: parseInt(offset) > 0,
    });
  } catch (error) {
    logger.error('Failed to fetch templates for admin', {
      error: error.message,
      query: req.query,
    });
    throw error;
  }
}

/**
 * Get template usage statistics with fake metrics for development
 */
export async function getTemplateStats(req, res, _next) {
  try {
    const { id } = req.params;

    const template = await prisma.template.findUnique({
      where: { id },
      include: {
        usage: {
          select: {
            usedCount: true,
            lastUsedAt: true,
            shop: {
              select: {
                shopDomain: true,
              },
            },
          },
        },
      },
    });

    if (!template) {
      throw new NotFoundError('Template');
    }

    const totalUsage = template.usage.reduce(
      (sum, usage) => sum + usage.usedCount,
      0,
    );
    const uniqueShops = template.usage.length;

    // Generate fake metrics for development (realistic ranges)
    const hasUrls =
      template.content.includes('{{') &&
      (template.content.includes('Url}}') ||
        template.content.includes('url}}'));

    const fakeMetrics = {
      deliveryRate: (92 + Math.random() * 6).toFixed(2), // 92-98%
      clickThroughRate: hasUrls ? (8 + Math.random() * 7).toFixed(2) : null, // 8-15% if URLs present
      replyRate: (2 + Math.random() * 3).toFixed(2), // 2-5%
      conversions: Math.floor(5 + Math.random() * 16), // 5-20 conversions
    };

    return sendSuccess(res, {
      template: {
        id: template.id,
        title: template.title,
        category: template.category,
        content: template.content,
      },
      stats: {
        timesUsed: totalUsage,
        uniqueShops,
        usage: template.usage,
      },
      metrics: {
        deliveryRate: `${fakeMetrics.deliveryRate}%`,
        clickThroughRate: fakeMetrics.clickThroughRate
          ? `${fakeMetrics.clickThroughRate}%`
          : 'N/A',
        replyRate: `${fakeMetrics.replyRate}%`,
        conversions: fakeMetrics.conversions,
        note: 'These are simulated metrics for development purposes',
      },
    });
  } catch (error) {
    logger.error('Failed to fetch template stats', {
      error: error.message,
      templateId: req.params.id,
    });
    throw error;
  }
}

export default {
  createTemplate,
  updateTemplate,
  deleteTemplate,
  getAllTemplatesAdmin,
  getTemplateStats,
};
