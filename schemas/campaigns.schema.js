import { z } from 'zod';

/**
 * Campaign Validation Schemas
 * Using Zod for type-safe input validation
 */

// Campaign status validation
const campaignStatusSchema = z.enum([
  'draft',
  'scheduled',
  'sending',
  'sent',
  'failed',
  'cancelled',
]);

// Schedule type validation
const scheduleTypeSchema = z.enum(['immediate', 'scheduled', 'recurring']);

// Audience validation
const audienceSchema = z.string().refine(
  val => {
    return (
      val === 'all' ||
      val === 'male' ||
      val === 'female' ||
      val === 'men' ||
      val === 'women' ||
      val.startsWith('segment:')
    );
  },
  {
    message:
      'Audience must be "all", "male", "female", "men", "women", or "segment:<id>"',
  },
);

/**
 * Create Campaign Schema
 */
export const createCampaignSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, 'Campaign name is required')
      .max(200, 'Campaign name too long'),
    message: z
      .string()
      .trim()
      .min(1, 'Campaign message is required')
      .max(1600, 'Message is too long (max 1600 characters)'),
    audience: audienceSchema.default('all'),
    discountId: z
      .string()
      .trim()
      .optional()
      .nullable()
      .refine(val => !val || val.length > 0, {
        message: 'Discount ID cannot be an empty string',
      }), // Optional - campaign can be created without discount
    scheduleType: scheduleTypeSchema.default('immediate'),
    scheduleAt: z
      .string()
      .trim()
      .datetime({
        message: 'Schedule date must be a valid ISO 8601 datetime string',
      })
      .optional()
      .refine(val => !val || val.length > 0, {
        message: 'Schedule date cannot be an empty string',
      }),
    recurringDays: z.number().int().positive().max(365).optional(),
  })
  .refine(
    data => {
      if (data.scheduleType === 'scheduled') {
        return !!data.scheduleAt && data.scheduleAt.trim().length > 0;
      }
      return true;
    },
    {
      message: 'Schedule date is required for scheduled campaigns',
      path: ['scheduleAt'],
    },
  )
  .refine(
    data => {
      if (data.scheduleType === 'recurring') {
        return !!data.recurringDays && data.recurringDays > 0;
      }
      return true;
    },
    {
      message: 'Recurring days is required for recurring campaigns',
      path: ['recurringDays'],
    },
  )
  .refine(
    data => {
      if (data.scheduleAt && data.scheduleAt.trim().length > 0) {
        const scheduleDate = new Date(data.scheduleAt);
        if (isNaN(scheduleDate.getTime())) {
          return false;
        }
        return scheduleDate > new Date();
      }
      return true;
    },
    {
      message: 'Schedule date must be in the future',
      path: ['scheduleAt'],
    },
  );

/**
 * Update Campaign Schema
 */
export const updateCampaignSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, 'Campaign name cannot be empty')
      .max(200, 'Campaign name too long')
      .optional(),
    message: z
      .string()
      .trim()
      .min(1, 'Campaign message cannot be empty')
      .max(1600, 'Message is too long (max 1600 characters)')
      .optional(),
    audience: audienceSchema.optional(),
    discountId: z
      .string()
      .trim()
      .optional()
      .nullable()
      .refine(val => val === null || val === undefined || val.length > 0, {
        message: 'Discount ID cannot be an empty string',
      }),
    scheduleType: scheduleTypeSchema.optional(),
    scheduleAt: z
      .string()
      .trim()
      .datetime({
        message: 'Schedule date must be a valid ISO 8601 datetime string',
      })
      .optional()
      .nullable()
      .refine(val => val === null || val === undefined || val.length > 0, {
        message: 'Schedule date cannot be an empty string',
      }),
    recurringDays: z.number().int().positive().max(365).optional().nullable(),
  })
  .refine(
    data => {
      // Filter out undefined values to check if at least one field is provided
      const definedFields = Object.entries(data).filter(
        ([_, value]) => value !== undefined,
      );
      return definedFields.length > 0;
    },
    {
      message: 'At least one field must be provided for update',
    },
  )
  .refine(
    data => {
      // If scheduleAt is provided and not null, validate it's in the future
      if (data.scheduleAt && data.scheduleAt.trim().length > 0) {
        const scheduleDate = new Date(data.scheduleAt);
        if (isNaN(scheduleDate.getTime())) {
          return false;
        }
        return scheduleDate > new Date();
      }
      return true;
    },
    {
      message: 'Schedule date must be in the future',
      path: ['scheduleAt'],
    },
  );

/**
 * List Campaigns Query Schema
 */
export const listCampaignsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
  status: campaignStatusSchema.optional(),
  sortBy: z
    .enum(['createdAt', 'updatedAt', 'name', 'scheduleAt'])
    .default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

/**
 * Schedule Campaign Schema
 */
export const scheduleCampaignSchema = z.object({
  scheduleType: scheduleTypeSchema.default('scheduled'),
  scheduleAt: z
    .string()
    .trim()
    .min(1, 'Schedule date is required')
    .datetime({
      message: 'Schedule date must be a valid ISO 8601 datetime string',
    })
    .refine(
      val => {
        const scheduleDate = new Date(val);
        if (isNaN(scheduleDate.getTime())) {
          return false;
        }
        return scheduleDate > new Date();
      },
      {
        message: 'Schedule date must be in the future',
      },
    ),
  recurringDays: z.number().int().positive().max(365).optional(),
});

export default {
  createCampaignSchema,
  updateCampaignSchema,
  listCampaignsQuerySchema,
  scheduleCampaignSchema,
};
