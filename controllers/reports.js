import { getStoreId } from '../middlewares/store-resolution.js';
import { logger } from '../utils/logger.js';
import {
  getKPIs,
  getCampaignPerformance,
  getAutomationInsights,
  getCreditUsage,
  getContactInsights,
} from '../services/reports.js';
import prisma from '../services/prisma.js';
import { sendSuccess } from '../utils/response.js';
import { NotFoundError } from '../utils/errors.js';

export async function overview(req, res, next) {
  try {
    const storeId = getStoreId(req);
    const { from, to } = req.query;

    logger.info('Reports overview requested', { storeId, from, to });

    // Get KPIs and basic metrics
    const kpis = await getKPIs(storeId);

    // Get campaign performance
    const campaignPerformance = await getCampaignPerformance(storeId, {
      from,
      to,
    });

    // Get automation insights
    const automationInsights = await getAutomationInsights(storeId, {
      from,
      to,
    });

    // Get credit usage
    const creditUsage = await getCreditUsage(storeId, { from, to });

    // Get contact insights
    const contactInsights = await getContactInsights(storeId, { from, to });

    return sendSuccess(res, {
      overview: {
        totalCampaigns: kpis.overview.totalCampaigns,
        totalContacts: kpis.overview.totalContacts,
        totalSmsSent: campaignPerformance.summary.totalMessages,
        deliveryRate: campaignPerformance.summary.deliveryRate,
        creditsRemaining: kpis.overview.creditsRemaining,
      },
      campaignPerformance: campaignPerformance.summary,
      automationInsights: automationInsights.summary,
      creditUsage: creditUsage.summary,
      contactInsights: contactInsights.summary,
      recentActivity: kpis.recentActivity,
      health: kpis.health,
      dateRange: {
        from:
          from || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
        to: to || new Date().toISOString(),
        window: '30d',
      },
    });
  } catch (error) {
    logger.error('Reports overview error', {
      error: error.message,
      stack: error.stack,
      storeId: getStoreId(req),
      query: req.query,
      requestId: req.id,
      path: req.path,
      method: req.method,
    });
    next(error);
  }
}

export async function campaigns(req, res, next) {
  try {
    const storeId = getStoreId(req);
    const { from, to, status, type, page = 1, limit = 20 } = req.query;

    logger.info('Campaign reports requested', {
      storeId,
      from,
      to,
      status,
      type,
    });

    // Get campaign performance data
    const campaignPerformance = await getCampaignPerformance(storeId, {
      from,
      to,
      status,
      type,
    });

    // Get paginated campaigns list
    // Validate status using same logic as campaigns service
    const validStatuses = [
      'draft',
      'scheduled',
      'sending',
      'sent',
      'failed',
      'cancelled',
    ];
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const campaigns = await prisma.campaign.findMany({
      where: {
        shopId: storeId,
        ...(from &&
          to && {
          createdAt: {
            gte: new Date(from),
            lte: new Date(to),
          },
        }),
        // Only filter by status if it's a valid campaign status (same validation as campaigns service)
        ...(status && validStatuses.includes(status) && { status }),
        ...(type && { type }),
      },
      select: {
        id: true,
        name: true,
        status: true,
        scheduleType: true,
        createdAt: true,
        updatedAt: true,
        _count: {
          select: {
            messages: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      skip: offset,
      take: parseInt(limit),
    });

    // Get total count for pagination
    const totalCount = await prisma.campaign.count({
      where: {
        shopId: storeId,
        ...(from &&
          to && {
          createdAt: {
            gte: new Date(from),
            lte: new Date(to),
          },
        }),
        // Only filter by status if it's a valid campaign status (same validation as campaigns service)
        ...(status && validStatuses.includes(status) && { status }),
        ...(type && { type }),
      },
    });

    return sendSuccess(res, {
      campaigns: campaigns.map(campaign => ({
        id: campaign.id,
        name: campaign.name,
        status: campaign.status, // Campaign status: draft, scheduled, sending, sent, failed, cancelled
        scheduleType: campaign.scheduleType,
        createdAt: campaign.createdAt,
        updatedAt: campaign.updatedAt,
        messageCount: campaign._count.messages,
      })),
      totalCount,
      campaignStats: {
        totalSent:
          campaignPerformance.summary.totalSent ||
          campaignPerformance.summary.totalMessages ||
          0,
        totalDelivered:
          campaignPerformance.summary.totalDelivered ||
          campaignPerformance.summary.delivered ||
          0,
        totalFailed:
          campaignPerformance.summary.totalFailed ||
          campaignPerformance.summary.failed ||
          0,
        avgDeliveryRate: campaignPerformance.summary.deliveryRate || 0,
        byStatus:
          campaignPerformance.campaignStats?.byStatus ||
          campaignPerformance.statusBreakdown?.reduce((acc, item) => {
            acc[item.status] = item.count;
            return acc;
          }, {}) ||
          {},
      },
      topPerformers: campaignPerformance.topPerformers,
      trends: campaignPerformance.trends,
      statusBreakdown: campaignPerformance.statusBreakdown, // Array of {status, count}
      pagination: {
        page: parseInt(page),
        pageSize: parseInt(limit),
        total: totalCount,
        totalPages: Math.ceil(totalCount / parseInt(limit)),
        hasNextPage: offset + parseInt(limit) < totalCount,
        hasPrevPage: parseInt(page) > 1,
      },
      dateRange: {
        from:
          from || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
        to: to || new Date().toISOString(),
      },
    });
  } catch (error) {
    logger.error('Campaign reports error', {
      error: error.message,
      stack: error.stack,
      storeId: getStoreId(req),
      query: req.query,
      requestId: req.id,
      path: req.path,
      method: req.method,
    });
    next(error);
  }
}

export async function campaignById(req, res, next) {
  try {
    const storeId = getStoreId(req);
    const { id } = req.params;

    logger.info('Campaign details requested', { storeId, campaignId: id });

    // Get campaign details
    const campaign = await prisma.campaign.findFirst({
      where: { id, shopId: storeId },
      select: {
        id: true,
        name: true,
        status: true,
        scheduleType: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!campaign) {
      throw new NotFoundError('Campaign');
    }

    // Get message analytics
    const messageStats = await prisma.messageLog.groupBy({
      by: ['status'],
      where: { campaignId: id, shopId: storeId },
      _count: { status: true },
    });

    const sent =
      messageStats.find(s => s.status === 'sent')?._count?.status || 0;
    const delivered =
      messageStats.find(s => s.status === 'delivered')?._count?.status || 0;
    const failed =
      messageStats.find(s => s.status === 'failed')?._count?.status || 0;
    const deliveryRate = sent > 0 ? (delivered / sent) * 100 : 0;

    // Get recipient analytics
    const recipientStats = await prisma.contact.groupBy({
      by: ['smsConsent'],
      where: {
        shopId: storeId,
        messageLogs: {
          some: { campaignId: id },
        },
      },
      _count: { smsConsent: true },
    });

    const totalRecipients = recipientStats.reduce(
      (sum, stat) => sum + stat._count.smsConsent,
      0,
    );
    const optedIn =
      recipientStats.find(s => s.smsConsent === 'opted_in')?._count
        ?.smsConsent || 0;
    const optedOut =
      recipientStats.find(s => s.smsConsent === 'opted_out')?._count
        ?.smsConsent || 0;

    // Get daily trends
    const dailyTrends = await prisma.messageLog.groupBy({
      by: ['createdAt'],
      where: { campaignId: id, shopId: storeId },
      _count: { id: true },
      orderBy: { createdAt: 'asc' },
    });

    return sendSuccess(res, {
      campaign,
      analytics: {
        sent,
        delivered,
        failed,
        deliveryRate: Math.round(deliveryRate * 100) / 100,
      },
      recipientAnalytics: {
        total: totalRecipients,
        optedIn,
        optedOut,
      },
      trends: dailyTrends.map(trend => ({
        date: trend.createdAt.toISOString().split('T')[0],
        messages: trend._count.id,
      })),
      creditsUsed: sent,
    });
  } catch (error) {
    logger.error('Campaign details error', {
      error: error.message,
      stack: error.stack,
      storeId: getStoreId(req),
      campaignId: req.params.id,
      requestId: req.id,
      path: req.path,
      method: req.method,
    });
    next(error);
  }
}

export async function automations(req, res, next) {
  try {
    const storeId = getStoreId(req);
    const { from, to } = req.query;

    logger.info('Automation reports requested', { storeId, from, to });

    // Get automation insights
    const automationInsights = await getAutomationInsights(storeId, {
      from,
      to,
    });

    return sendSuccess(res, {
      summary: automationInsights.summary,
      statusBreakdown: automationInsights.statusBreakdown,
      typeBreakdown: automationInsights.typeBreakdown,
      trends: automationInsights.trends,
      activeAutomations: automationInsights.activeAutomations,
      dateRange: {
        from:
          from || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
        to: to || new Date().toISOString(),
      },
    });
  } catch (error) {
    logger.error('Automation reports error', {
      error: error.message,
      stack: error.stack,
      storeId: getStoreId(req),
      query: req.query,
      requestId: req.id,
      path: req.path,
      method: req.method,
    });
    next(error);
  }
}

export async function messaging(req, res, next) {
  try {
    const storeId = getStoreId(req);
    const { from, to } = req.query;

    logger.info('Messaging reports requested', { storeId, from, to });

    // Get message stats by direction
    const directionStats = await prisma.messageLog.groupBy({
      by: ['direction'],
      where: {
        shopId: storeId,
        ...(from &&
          to && {
          createdAt: {
            gte: new Date(from),
            lte: new Date(to),
          },
        }),
      },
      _count: { direction: true },
    });

    // Get message stats by status
    const statusStats = await prisma.messageLog.groupBy({
      by: ['status'],
      where: {
        shopId: storeId,
        ...(from &&
          to && {
          createdAt: {
            gte: new Date(from),
            lte: new Date(to),
          },
        }),
      },
      _count: { status: true },
    });

    // Get daily trends
    const dailyTrends = await prisma.messageLog.groupBy({
      by: ['createdAt'],
      where: {
        shopId: storeId,
        ...(from &&
          to && {
          createdAt: {
            gte: new Date(from),
            lte: new Date(to),
          },
        }),
      },
      _count: { id: true },
      orderBy: { createdAt: 'asc' },
    });

    const totalMessages = directionStats.reduce(
      (sum, stat) => sum + stat._count.direction,
      0,
    );
    const inbound =
      directionStats.find(s => s.direction === 'inbound')?._count?.direction ||
      0;
    const outbound =
      directionStats.find(s => s.direction === 'outbound')?._count?.direction ||
      0;

    const sent =
      statusStats.find(s => s.status === 'sent')?._count?.status || 0;
    const delivered =
      statusStats.find(s => s.status === 'delivered')?._count?.status || 0;
    const failed =
      statusStats.find(s => s.status === 'failed')?._count?.status || 0;

    return sendSuccess(res, {
      totalMessages,
      byDirection: { inbound, outbound },
      byStatus: { sent, delivered, failed },
      trends: dailyTrends.map(trend => ({
        date: trend.createdAt.toISOString().split('T')[0],
        messages: trend._count.id,
      })),
      dateRange: {
        from:
          from || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
        to: to || new Date().toISOString(),
      },
    });
  } catch (error) {
    logger.error('Messaging reports error', {
      error: error.message,
      stack: error.stack,
      storeId: getStoreId(req),
      query: req.query,
      requestId: req.id,
      path: req.path,
      method: req.method,
    });
    next(error);
  }
}

export async function credits(req, res, next) {
  try {
    const storeId = getStoreId(req);
    const { from, to, usageType } = req.query;

    logger.info('Credit reports requested', { storeId, from, to, usageType });

    // Get credit usage data
    const creditUsage = await getCreditUsage(storeId, { from, to, usageType });

    return sendSuccess(res, {
      summary: creditUsage.summary,
      usageBreakdown: creditUsage.usageBreakdown,
      trends: creditUsage.trends,
      recentPurchases: creditUsage.recentPurchases,
      dateRange: {
        from:
          from || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
        to: to || new Date().toISOString(),
      },
    });
  } catch (error) {
    logger.error('Credit reports error', {
      error: error.message,
      stack: error.stack,
      storeId: getStoreId(req),
      query: req.query,
      requestId: req.id,
      path: req.path,
      method: req.method,
    });
    next(error);
  }
}

export async function kpis(req, res, next) {
  try {
    const storeId = getStoreId(req);

    logger.info('KPIs requested', { storeId });

    // Get KPIs data
    const kpis = await getKPIs(storeId);

    return sendSuccess(res, kpis);
  } catch (error) {
    logger.error('KPIs error', {
      error: error.message,
      stack: error.stack,
      storeId: getStoreId(req),
      requestId: req.id,
      path: req.path,
      method: req.method,
    });
    next(error);
  }
}

export async function contacts(req, res, next) {
  try {
    const storeId = getStoreId(req);
    const { from, to } = req.query;

    logger.info('Contact reports requested', { storeId, from, to });

    // Get contact insights
    const contactInsights = await getContactInsights(storeId, { from, to });

    return sendSuccess(res, {
      summary: contactInsights.summary,
      genderDistribution: contactInsights.genderDistribution,
      consentBreakdown: contactInsights.consentBreakdown,
      dateRange: {
        from:
          from || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
        to: to || new Date().toISOString(),
      },
    });
  } catch (error) {
    logger.error('Contact reports error', {
      error: error.message,
      stack: error.stack,
      storeId: getStoreId(req),
      query: req.query,
      requestId: req.id,
      path: req.path,
      method: req.method,
    });
    next(error);
  }
}

export async function exportData(req, res, next) {
  try {
    const storeId = getStoreId(req);
    const { type = 'overview', format = 'csv' } = req.query;

    logger.info('Export requested', { storeId, type, format });

    // Generate export data based on type
    let exportData = {};

    switch (type) {
    case 'campaigns':
      exportData = await getCampaignPerformance(storeId, req.query);
      break;
    case 'automations':
      exportData = await getAutomationInsights(storeId, req.query);
      break;
    case 'credits':
      exportData = await getCreditUsage(storeId, req.query);
      break;
    case 'contacts':
      exportData = await getContactInsights(storeId, req.query);
      break;
    default:
      exportData = await getKPIs(storeId);
    }

    // For now, return the data directly
    // In production, you'd generate a file and return a download URL
    return sendSuccess(res, {
      exportData,
      format,
      reportType: type,
      generatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });
  } catch (error) {
    logger.error('Export error', {
      error: error.message,
      stack: error.stack,
      storeId: getStoreId(req),
      query: req.query,
      requestId: req.id,
      path: req.path,
      method: req.method,
    });
    next(error);
  }
}
