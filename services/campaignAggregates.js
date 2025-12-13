import prisma from './prisma.js';
import { logger } from '../utils/logger.js';
import { CampaignStatus } from '../utils/prismaEnums.js';
import { releaseCredits } from './wallet.js';

/**
 * Update campaign aggregates (total, sent, failed, processed) from CampaignRecipient counts
 * Phase 2.2: sent = only actually sent (status='sent'), processed = sent + failed
 * Note: "delivered" status is mapped to "sent" - we only track sent/failed
 *
 * @param {string} campaignId - Campaign ID
 * @param {string} shopId - Shop ID for scoping
 * @returns {Promise<Object>} Updated aggregate counts
 */
export async function updateCampaignAggregates(campaignId, shopId) {
  try {
    // Verify campaign exists and belongs to shop
    const campaign = await prisma.campaign.findFirst({
      where: { id: campaignId, shopId },
      select: { id: true },
    });

    if (!campaign) {
      logger.warn({ campaignId, shopId }, 'Campaign not found or not owned by shop');
      return null;
    }

    // Count recipients by status (Phase 2.2: sent = only actually sent, not processed)
    const [total, success, failed] = await Promise.all([
      prisma.campaignRecipient.count({
        where: { campaignId },
      }),
      prisma.campaignRecipient.count({
        where: {
          campaignId,
          status: 'sent', // Only actually sent messages (Phase 2.2)
        },
      }),
      prisma.campaignRecipient.count({
        where: {
          campaignId,
          status: 'failed',
        },
      }),
    ]);

    // Calculate processed (sent + failed) - Phase 2.2
    const processed = success + failed;

    // Check if all recipients are processed (no pending recipients remaining)
    const pendingCount = await prisma.campaignRecipient.count({
      where: {
        campaignId,
        status: 'pending',
      },
    });

    // Determine campaign status based on recipient states
    let campaignStatus = null;
    if (pendingCount > 0) {
      // Still has pending recipients - keep as 'sending'
      campaignStatus = CampaignStatus.sending;
    } else if (total > 0 && processed === total) {
      // All recipients have been processed (sent or failed) - Phase 2.2
      // If all failed, mark as failed, otherwise mark as sent
      if (failed === total) {
        campaignStatus = CampaignStatus.failed;
      } else {
        campaignStatus = CampaignStatus.sent;
      }
    }
    // If total === 0, don't change status (campaign might be in draft)

    // Update campaign metrics (Phase 2.2: sent = success, add processed)
    const updateData = {
      totalSent: success,        // Actually sent (not processed) - Phase 2.2
      totalFailed: failed,
      totalProcessed: processed, // New: sent + failed - Phase 2.2
      updatedAt: new Date(),
    };

    // Update campaign metrics
    await prisma.campaignMetrics.upsert({
      where: { campaignId },
      create: {
        campaignId,
        ...updateData,
      },
      update: updateData,
    });

    // Only update campaign status if we determined a new status
    if (campaignStatus) {
      await prisma.campaign.updateMany({
        where: { id: campaignId, shopId },
        data: {
          status: campaignStatus,
          updatedAt: new Date(),
        },
      });

      // Release credit reservation when campaign completes (sent or failed)
      // This happens only once when campaign transitions from 'sending' to final status
      if (
        campaignStatus === CampaignStatus.sent ||
        campaignStatus === CampaignStatus.failed
      ) {
        try {
          // Find active reservation for this campaign
          const reservation = await prisma.creditReservation.findFirst({
            where: {
              campaignId,
              shopId,
              status: 'active',
            },
            orderBy: { createdAt: 'desc' },
          });

          if (reservation) {
            // Calculate actual credits used (sent messages only)
            const creditsUsed = success; // Only count successfully sent messages

            // Release unused credits from reservation
            // Note: Credits for sent messages are already debited in smsBulk.js
            // We only need to release the reservation, not refund credits
            await releaseCredits(reservation.id, {
              reason: `campaign_${campaignStatus}`,
            });

            logger.info(
              {
                campaignId,
                shopId,
                reservationId: reservation.id,
                reserved: reservation.amount,
                creditsUsed,
                creditsReleased: reservation.amount - creditsUsed,
                campaignStatus,
              },
              'Credit reservation released after campaign completion',
            );
          } else {
            logger.warn(
              { campaignId, shopId },
              'No active credit reservation found for campaign',
            );
          }
        } catch (releaseError) {
          // Don't fail aggregate update if credit release fails
          logger.error(
            {
              campaignId,
              shopId,
              error: releaseError.message,
            },
            'Failed to release credit reservation',
          );
        }
      }
    }

    logger.info({
      campaignId,
      total,
      sent: success,        // Actually sent - Phase 2.2
      processed,           // New: sent + failed - Phase 2.2
      failed,
      pendingCount,
      campaignStatus: campaignStatus || 'unchanged',
    }, 'Campaign aggregates updated (Phase 2.2)');

    return { total, sent: success, processed, failed, campaignStatus };
  } catch (err) {
    logger.error({ campaignId, shopId, err: err.message }, 'Failed to update campaign aggregates');
    // Don't throw - aggregates can be recalculated later
    return null;
  }
}

/**
 * Recalculate aggregates for all campaigns owned by a shop
 * Useful for bulk updates or data consistency checks
 *
 * @param {string} shopId - Shop ID
 * @returns {Promise<Object>} Summary of updates
 */
export async function recalculateAllCampaignAggregates(shopId) {
  try {
    const campaigns = await prisma.campaign.findMany({
      where: { shopId },
      select: { id: true },
    });

    let updated = 0;
    let errors = 0;

    for (const campaign of campaigns) {
      const result = await updateCampaignAggregates(campaign.id, shopId);
      if (result) {
        updated++;
      } else {
        errors++;
      }
    }

    logger.info({ shopId, updated, errors, total: campaigns.length }, 'Bulk campaign aggregates update completed');

    return { updated, errors, total: campaigns.length };
  } catch (err) {
    logger.error({ shopId, err: err.message }, 'Failed to recalculate all campaign aggregates');
    throw err;
  }
}

export default {
  updateCampaignAggregates,
  recalculateAllCampaignAggregates,
};

