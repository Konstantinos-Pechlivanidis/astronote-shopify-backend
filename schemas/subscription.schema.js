import { z } from 'zod';

export const subscriptionSubscribeSchema = z.object({
  planType: z.enum(['starter', 'pro'], {
    errorMap: () => ({ message: 'Plan type must be "starter" or "pro"' }),
  }),
});

export const subscriptionUpdateSchema = z.object({
  planType: z.enum(['starter', 'pro'], {
    errorMap: () => ({ message: 'Plan type must be "starter" or "pro"' }),
  }),
});

export const subscriptionVerifySessionSchema = z.object({
  sessionId: z.string().min(1, 'Session ID is required'),
});
