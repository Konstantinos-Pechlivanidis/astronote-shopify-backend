import prisma from '../../services/prisma.js';
import {
  sendSms,
  MittoApiError,
  ValidationError,
} from '../../services/mitto.js';
import { logger } from '../../utils/logger.js';
import { deliveryStatusQueue } from '../index.js';

export async function handleMittoSend(job) {
  const { campaignId, shopId, phoneE164, message, sender } = job.data;

  try {
    // Skip credit consumption for campaign messages (credits already consumed at campaign level)
    // Individual SMS (non-campaign) will consume credits normally
    const isCampaignMessage = !!campaignId;

    // Use new SMS service with updated API
    const res = await sendSms({
      to: phoneE164,
      text: message,
      senderOverride: sender,
      shopId,
      skipCreditCheck: isCampaignMessage, // Skip credit check for campaign messages
    });

    const msgId = res?.messageId || null;

    // Update existing campaign recipient record (created during campaign send)
    // Find the recipient record for this campaign and phone
    const recipient = await prisma.campaignRecipient.findFirst({
      where: {
        campaignId,
        phoneE164,
      },
    });

    if (recipient) {
      // Update existing record
      await prisma.campaignRecipient.update({
        where: { id: recipient.id },
        data: {
          status: 'sent',
          mittoMessageId: msgId,
          sentAt: new Date(),
          senderNumber: sender,
          deliveryStatus: 'Queued', // Initial status from Mitto
        },
      });
    } else {
      // Fallback: create new record if not found (shouldn't happen normally)
      logger.warn('Campaign recipient not found, creating new record', {
        campaignId,
        phoneE164,
      });
      await prisma.campaignRecipient.create({
        data: {
          campaignId,
          contactId: null,
          phoneE164,
          status: 'sent',
          mittoMessageId: msgId,
          sentAt: new Date(),
          senderNumber: sender,
          deliveryStatus: 'Queued',
        },
      });
    }

    // Create message log with sender info
    await prisma.messageLog.create({
      data: {
        shopId,
        phoneE164,
        direction: 'outbound',
        provider: 'mitto',
        providerMsgId: msgId,
        status: 'sent',
        campaignId,
        senderNumber: sender,
        deliveryStatus: 'Queued',
      },
    });

    // Update campaign metrics
    await prisma.campaignMetrics.update({
      where: { campaignId },
      data: { totalSent: { increment: 1 } },
    });

    // Queue delivery status update job (with delay to allow Mitto to process)
    // Check status after 30 seconds, then again after 2 minutes, then after 5 minutes
    if (campaignId && msgId) {
      try {
        // First check after 30 seconds
        await deliveryStatusQueue.add(
          'update-campaign-status',
          { campaignId },
          {
            delay: 30000, // 30 seconds
            jobId: `status-update-${campaignId}-30s`,
          },
        );

        // Second check after 2 minutes
        await deliveryStatusQueue.add(
          'update-campaign-status',
          { campaignId },
          {
            delay: 120000, // 2 minutes
            jobId: `status-update-${campaignId}-2m`,
          },
        );

        // Final check after 5 minutes
        await deliveryStatusQueue.add(
          'update-campaign-status',
          { campaignId },
          {
            delay: 300000, // 5 minutes
            jobId: `status-update-${campaignId}-5m`,
          },
        );

        logger.info('Queued delivery status update jobs', {
          campaignId,
          msgId,
        });
      } catch (queueError) {
        // Log but don't fail the SMS send if status update queue fails
        logger.warn('Failed to queue delivery status update', {
          campaignId,
          msgId,
          error: queueError.message,
        });
      }
    }

    logger.info('SMS sent successfully via queue', {
      campaignId,
      phoneE164,
      msgId,
    });

    return { ok: true, msgId };
  } catch (err) {
    const errorMessage = err?.message || String(err);
    const errorType =
      err instanceof ValidationError
        ? 'validation'
        : err instanceof MittoApiError
          ? 'api'
          : 'unknown';

    logger.error('SMS send failed via queue', {
      campaignId,
      phoneE164,
      error: errorMessage,
      errorType,
    });

    // Update existing campaign recipient record with failure status
    const recipient = await prisma.campaignRecipient.findFirst({
      where: {
        campaignId,
        phoneE164,
      },
    });

    if (recipient) {
      await prisma.campaignRecipient.update({
        where: { id: recipient.id },
        data: {
          status: 'failed',
          error: errorMessage,
        },
      });
    } else {
      // Fallback: create new record if not found
      await prisma.campaignRecipient.create({
        data: {
          campaignId,
          contactId: null,
          phoneE164,
          status: 'failed',
          error: errorMessage,
        },
      });
    }

    // Create failed message log
    await prisma.messageLog.create({
      data: {
        shopId,
        phoneE164,
        direction: 'outbound',
        provider: 'mitto',
        status: 'failed',
        error: errorMessage,
        campaignId,
      },
    });

    // Update campaign metrics
    await prisma.campaignMetrics.update({
      where: { campaignId },
      data: { totalFailed: { increment: 1 } },
    });

    throw err;
  }
}

export default { handleMittoSend };
