import crypto from 'crypto';
import prisma from '../services/prisma.js';
import { sendSuccess } from '../utils/response.js';
import { AuthenticationError } from '../utils/errors.js';
import { updateCampaignAggregates } from '../services/campaignAggregates.js';
import { logger } from '../utils/logger.js';

function verifyMittoSignature(req) {
  const secret = process.env.MITTO_WEBHOOK_SECRET;
  if (!secret) return true; // skip if not configured
  const sig = req.header('x-mitto-signature') || '';
  const body = JSON.stringify(req.body || {});
  const mac = crypto.createHmac('sha256', secret).update(body).digest('hex');
  return sig === mac;
}

/**
 * Map Mitto deliveryStatus → our internal status
 * Mitto sends: "Sent", "Delivered", "Failure" (capitalized)
 * We only use "sent" and "failed" - map "Delivered" to "sent"
 */
function mapStatus(s) {
  const v = String(s || '').toLowerCase().trim();
  // Mitto's exact values: "Delivered" → "sent", "Sent" → "sent", "Failure" → "failed"
  if (v === 'delivered' || v === 'delivrd' || v === 'completed' || v === 'ok') {
    // Map delivered to sent (we don't track delivered separately)
    return 'sent';
  }
  if (v === 'failure' || v === 'failed' || v === 'undelivered' || v === 'expired' || v === 'rejected' || v === 'error') {
    return 'failed';
  }
  if (v === 'sent' || v === 'queued' || v === 'accepted' || v === 'submitted' || v === 'enroute') {
    return 'sent';
  }
  return 'unknown';
}

export async function deliveryReport(req, res) {
  try {
    if (!verifyMittoSignature(req)) {
      throw new AuthenticationError('Invalid Mitto webhook signature');
    }

    const body = req.body || {};
    const events = Array.isArray(body) ? body : [body];

    let updated = 0;
    const affectedCampaigns = new Set(); // Track campaignIds that need aggregate updates

    for (const ev of events) {
      // Mitto webhook format: { messageId, deliveryStatus, ... }
      // Also support alternative field names for flexibility
      const providerId = ev?.messageId || ev?.message_id || ev?.id || ev?.MessageId || null;
      // Mitto sends deliveryStatus (not status)
      const statusIn = ev?.deliveryStatus || ev?.status || ev?.Status || ev?.dlr_status || ev?.delivery_status || null;
      const doneAtRaw = ev?.updatedAt || ev?.doneAt || ev?.timestamp || ev?.Timestamp || ev?.createdAt || new Date().toISOString();
      let doneAt = new Date(doneAtRaw);
      const errorDesc = ev?.error || ev?.Error || ev?.description || ev?.errorMessage || null;

      // Validate doneAt date
      if (isNaN(doneAt.getTime())) {
        doneAt = new Date();
      }

      if (!providerId) {
        logger.warn('DLR webhook missing messageId', { event: ev });
        continue;
      }

      // Map Mitto status to our internal status
      const newStatus = mapStatus(statusIn);

      if (newStatus === 'unknown') {
        logger.warn('Unknown DLR status', { providerId, statusIn, event: ev });
        continue;
      }

      // Find CampaignRecipient by providerMessageId (primary lookup for bulk SMS)
      const recipient = await prisma.campaignRecipient.findFirst({
        where: { mittoMessageId: providerId },
        select: { id: true, campaignId: true, status: true, shopId: true },
        include: {
          campaign: {
            select: { shopId: true },
          },
        },
      });

      if (recipient) {
        // Update recipient status (Phase 2.2: sent/failed only)
        const updateData = {
          deliveryStatus: statusIn,
          updatedAt: new Date(),
        };

        if (newStatus === 'sent') {
          updateData.status = 'sent';
          updateData.deliveredAt = doneAt;
          if (!recipient.sentAt) {
            updateData.sentAt = doneAt;
          }
          updateData.error = null;
        } else if (newStatus === 'failed') {
          updateData.status = 'failed';
          updateData.error = errorDesc || 'Delivery failed';
        }

        await prisma.campaignRecipient.update({
          where: { id: recipient.id },
          data: updateData,
        });

        updated++;
        affectedCampaigns.add(recipient.campaignId);
      }

      // Also update MessageLog if exists (for non-campaign messages or fallback)
      const log = await prisma.messageLog.findFirst({
        where: { providerMsgId: providerId },
        select: { id: true, campaignId: true },
      });

      if (log) {
        await prisma.messageLog.update({
          where: { id: log.id },
          data: {
            deliveryStatus: statusIn,
            status: newStatus === 'sent' ? 'sent' : 'failed',
            updatedAt: new Date(),
            payload: ev,
          },
        });

        // If log has campaignId but recipient wasn't found, still track for aggregates
        if (log.campaignId && !affectedCampaigns.has(log.campaignId)) {
          affectedCampaigns.add(log.campaignId);
        }
      }
    }

    // Update campaign aggregates for affected campaigns (non-blocking, Phase 2.2)
    if (affectedCampaigns.size > 0) {
      const updatePromises = Array.from(affectedCampaigns).map(async (campaignId) => {
        try {
          // Get shopId from campaign
          const campaign = await prisma.campaign.findUnique({
            where: { id: campaignId },
            select: { shopId: true },
          });
          if (campaign) {
            await updateCampaignAggregates(campaignId, campaign.shopId);
          }
        } catch (err) {
          logger.warn('Failed to update campaign aggregates after DLR', {
            campaignId,
            err: err.message,
          });
        }
      });

      // Don't await - fire and forget
      Promise.all(updatePromises).catch((err) => {
        logger.error('Error updating campaign aggregates after DLR', {
          err: err.message,
        });
      });
    }

    logger.info('DLR webhook processed', {
      eventsReceived: events.length,
      updated,
      affectedCampaigns: affectedCampaigns.size,
    });

    // Always return 202 to avoid retry storms
    return res.status(202).json({ ok: true, updated, affectedCampaigns: affectedCampaigns.size });
  } catch (e) {
    logger.error('DLR webhook error', {
      error: e.message,
      stack: e.stack,
      body: req.body,
    });
    // Still return 202 to avoid retry storms
    return res.status(202).json({ ok: false, error: 'Internal error' });
  }
}

export async function inboundMessage(req, res, next) {
  try {
    if (!verifyMittoSignature(req)) {
      throw new AuthenticationError('Invalid Mitto webhook signature');
    }
    const payload = req.body || {};
    const from = payload.from || payload.msisdn || null;

    // Try to resolve shopId from phone number (find contact with this phone)
    let shopId = 'unknown';
    if (from) {
      try {
        const contact = await prisma.contact.findFirst({
          where: { phoneE164: from },
          select: { shopId: true },
        });
        if (contact) {
          shopId = contact.shopId;
        } else {
          // If no contact found, try to find from recent outbound messages
          const recentMessage = await prisma.messageLog.findFirst({
            where: {
              phoneE164: from,
              direction: 'outbound',
            },
            orderBy: { createdAt: 'desc' },
            select: { shopId: true },
          });
          if (recentMessage) {
            shopId = recentMessage.shopId;
          }
        }
      } catch (lookupError) {
        logger.warn('Failed to resolve shopId for inbound message', {
          phoneE164: from,
          error: lookupError.message,
        });
        // Continue with 'unknown' shopId
      }
    }

    await prisma.messageLog.create({
      data: {
        shopId,
        phoneE164: from || '',
        direction: 'inbound',
        provider: 'mitto',
        status: 'received',
        payload,
      },
    });

    logger.info('Inbound message received', {
      shopId,
      phoneE164: from,
    });

    return sendSuccess(res, { ok: true });
  } catch (e) {
    next(e);
  }
}
