import crypto from 'crypto';
import prisma from '../services/prisma.js';
import { sendSuccess } from '../utils/response.js';
import { AuthenticationError } from '../utils/errors.js';

function verifyMittoSignature(req) {
  const secret = process.env.MITTO_WEBHOOK_SECRET;
  if (!secret) return true; // skip if not configured
  const sig = req.header('x-mitto-signature') || '';
  const body = JSON.stringify(req.body || {});
  const mac = crypto.createHmac('sha256', secret).update(body).digest('hex');
  return sig === mac;
}

export async function deliveryReport(req, res, next) {
  try {
    if (!verifyMittoSignature(req)) {
      throw new AuthenticationError('Invalid Mitto webhook signature');
    }
    const payload = req.body || {};
    const messageId = payload.message_id || payload.id || null;
    const to = payload.to || payload.msisdn || null;
    const status = payload.status || payload.dlr_status || 'delivered';

    const log = await prisma.messageLog.findFirst({
      where: { providerMsgId: messageId },
    });
    if (log) {
      await prisma.messageLog.update({
        where: { id: log.id },
        data: { status, payload },
      });
      if (log.campaignId) {
        await prisma.campaignRecipient.updateMany({
          where: { campaignId: log.campaignId, phoneE164: to },
          data: {
            status,
            deliveredAt: status === 'delivered' ? new Date() : null,
          },
        });
        if (status === 'delivered') {
          await prisma.campaignMetrics.updateMany({
            where: { campaignId: log.campaignId },
            data: { totalDelivered: { increment: 1 } },
          });
        }
      }
    }
    return sendSuccess(res, { ok: true });
  } catch (e) {
    next(e);
  }
}

export async function inboundMessage(req, res, next) {
  try {
    if (!verifyMittoSignature(req)) {
      throw new AuthenticationError('Invalid Mitto webhook signature');
    }
    const payload = req.body || {};
    const from = payload.from || payload.msisdn || null;
    await prisma.messageLog.create({
      data: {
        shopId: 'unknown', // TODO: resolve by mapping
        phoneE164: from || '',
        direction: 'inbound',
        provider: 'mitto',
        status: 'received',
        payload,
      },
    });
    return sendSuccess(res, { ok: true });
  } catch (e) {
    next(e);
  }
}
