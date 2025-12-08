import { z } from 'zod';

/**
 * Billing Validation Schemas
 * Using Zod for type-safe input validation
 */

// Package IDs
const packageIdSchema = z.enum(
  ['package_1000', 'package_5000', 'package_10000', 'package_25000'],
  {
    errorMap: () => ({ message: 'Invalid package ID' }),
  },
);

// Transaction type
const transactionTypeSchema = z.enum([
  'purchase',
  'debit',
  'credit',
  'refund',
  'adjustment',
]);

// Transaction status
const transactionStatusSchema = z.enum(['pending', 'completed', 'failed']);

// Currency schema
const currencySchema = z
  .enum(['EUR', 'USD'], {
    errorMap: () => ({ message: 'Currency must be EUR or USD' }),
  })
  .optional()
  .default('EUR');

/**
 * Create Purchase Session Schema
 */
export const createPurchaseSchema = z.object({
  packageId: packageIdSchema,
  successUrl: z
    .string()
    .trim()
    .min(1, 'Success URL is required')
    .refine(
      val => {
        try {
          new URL(val);
          return true;
        } catch {
          return false;
        }
      },
      { message: 'Success URL must be a valid URL' },
    ),
  cancelUrl: z
    .string()
    .trim()
    .min(1, 'Cancel URL is required')
    .refine(
      val => {
        try {
          new URL(val);
          return true;
        } catch {
          return false;
        }
      },
      { message: 'Cancel URL must be a valid URL' },
    ),
  currency: currencySchema, // Optional currency selection (EUR or USD)
});

/**
 * Transaction History Query Schema
 */
export const transactionHistoryQuerySchema = z
  .object({
    page: z.coerce.number().int().positive().default(1),
    pageSize: z.coerce.number().int().positive().max(100).default(20),
    type: transactionTypeSchema.optional(),
    startDate: z
      .string()
      .trim()
      .datetime({
        message: 'Start date must be a valid ISO 8601 datetime string',
      })
      .optional()
      .refine(val => !val || val.length > 0, {
        message: 'Start date cannot be an empty string',
      }),
    endDate: z
      .string()
      .trim()
      .datetime({
        message: 'End date must be a valid ISO 8601 datetime string',
      })
      .optional()
      .refine(val => !val || val.length > 0, {
        message: 'End date cannot be an empty string',
      }),
  })
  .refine(
    data => {
      if (
        data.startDate &&
        data.endDate &&
        data.startDate.trim().length > 0 &&
        data.endDate.trim().length > 0
      ) {
        const startDate = new Date(data.startDate);
        const endDate = new Date(data.endDate);
        if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
          return false;
        }
        return startDate <= endDate;
      }
      return true;
    },
    {
      message: 'Start date must be before or equal to end date',
      path: ['startDate'],
    },
  );

/**
 * Billing History Query Schema
 */
export const billingHistoryQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
  status: transactionStatusSchema.optional(),
});

/**
 * Top-up Calculate Query Schema
 */
export const topupCalculateQuerySchema = z.object({
  credits: z.coerce
    .number()
    .int()
    .positive()
    .max(1000000, 'Maximum 1,000,000 credits allowed per purchase'),
});

/**
 * Top-up Create Schema
 */
export const topupCreateSchema = z.object({
  credits: z
    .number()
    .int()
    .positive()
    .max(1000000, 'Maximum 1,000,000 credits allowed per purchase'),
  successUrl: z
    .string()
    .trim()
    .min(1, 'Success URL is required')
    .refine(
      val => {
        try {
          new URL(val);
          return true;
        } catch {
          return false;
        }
      },
      { message: 'Success URL must be a valid URL' },
    ),
  cancelUrl: z
    .string()
    .trim()
    .min(1, 'Cancel URL is required')
    .refine(
      val => {
        try {
          new URL(val);
          return true;
        } catch {
          return false;
        }
      },
      { message: 'Cancel URL must be a valid URL' },
    ),
});

export default {
  createPurchaseSchema,
  transactionHistoryQuerySchema,
  billingHistoryQuerySchema,
  topupCalculateQuerySchema,
  topupCreateSchema,
  currencySchema,
};
