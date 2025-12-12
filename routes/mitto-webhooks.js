import { Router } from 'express';
import prisma from '../services/prisma.js';
import { logger } from '../utils/logger.js';
import { updateCampaignAggregates } from '../services/campaignAggregates.js';
import crypto from 'crypto';

const router = Router();

/**
 * Verify webhook signature
 * Dev: ?secret=WEBHOOK_SECRET OR header X-Webhook-Token: WEBHOOK_SECRET
 * Prod: HMAC(SHA256, WEBHOOK_SECRET) over req.rawBody in header X-Webhook-Signature
 */
function verifyWebhook(req) {
  const shared = process.env.WEBHOOK_SECRET || process.env.MITTO_WEBHOOK_SECRET;
  if (!shared) {
    return false;
  }

  // Dev conveniences
  if (req.query?.secret && req.query.secret === shared) {
    return true;
  }
  const token = req.header('X-Webhook-Token');
  if (token && token === shared) {
    return true;
  }

  // Prod HMAC
  const sig = req.header('X-Webhook-Signature');
  if (!sig || !req.rawBody) {
    return false;
  }
  const mac = crypto.createHmac('sha256', shared).update(req.rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(sig, 'utf8'), Buffer.from(mac, 'utf8'));
  } catch {
    return false;
  }
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

/**
 * Delivery Status (DLR) Webhook
 * Accepts single object or array of objects. Always 202 to avoid retry storms.
 */
router.post('/webhooks/mitto/dlr', async (req, res) => {
  try {
    if (!verifyWebhook(req)) {
      logger.warn('DLR webhook verification failed', {
        headers: req.headers,
        query: req.query,
      });
      return res.status(401).json({ ok: false, message: 'Unauthorized' });
    }

    const body = req.body;
    const events = Array.isArray(body) ? body : [body];

    let updated = 0;
    const affectedCampaigns = new Set(); // Track campaignIds that need aggregate updates

    for (const ev of events) {
      // Mitto webhook format: { messageId, deliveryStatus, ... }
      // Also support alternative field names for flexibility
      const providerId = ev?.messageId || ev?.id || ev?.MessageId || null;
      // Mitto sends deliveryStatus (not status)
      const statusIn = ev?.deliveryStatus || ev?.status || ev?.Status || ev?.delivery_status || null;
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

      // Find CampaignRecipient by providerMessageId
      const recipient = await prisma.campaignRecipient.findFirst({
        where: { mittoMessageId: providerId },
        select: { id: true, campaignId: true, status: true },
      });

      if (!recipient) {
        logger.debug('DLR webhook: recipient not found', { providerId });
        // Also check MessageLog for non-campaign messages
        await prisma.messageLog.updateMany({
          where: { providerMsgId: providerId },
          data: {
            deliveryStatus: statusIn,
            status: newStatus === 'sent' ? 'sent' : 'failed',
            updatedAt: new Date(),
          },
        });
        continue;
      }

      // Update recipient status
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

      // Also update MessageLog if exists
      await prisma.messageLog.updateMany({
        where: { providerMsgId: providerId },
        data: {
          deliveryStatus: statusIn,
          status: newStatus === 'sent' ? 'sent' : 'failed',
          updatedAt: new Date(),
        },
      });

      updated++;
      affectedCampaigns.add(recipient.campaignId);
    }

    // Update campaign aggregates for affected campaigns (non-blocking)
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
  } catch (error) {
    logger.error('DLR webhook error', {
      error: error.message,
      stack: error.stack,
      body: req.body,
    });
    // Still return 202 to avoid retry storms
    return res.status(202).json({ ok: false, error: 'Internal error' });
  }
});

export default router;

