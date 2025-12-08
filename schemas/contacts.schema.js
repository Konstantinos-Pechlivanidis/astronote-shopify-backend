import { z } from 'zod';

/**
 * Contact Validation Schemas
 * Using Zod for type-safe input validation
 */

// Phone number validation (E.164 format)
const phoneE164Schema = z
  .string()
  .trim()
  .min(1, 'Phone number is required')
  .regex(
    /^\+[1-9]\d{1,14}$/,
    'Phone number must be in E.164 format (e.g., +306977123456)',
  );

// Email validation
const emailSchema = z
  .union([
    z
      .string()
      .trim()
      .email('Invalid email format')
      .max(255, 'Email is too long'),
    z.null(),
  ])
  .optional()
  .refine(
    val =>
      val === null ||
      val === undefined ||
      (typeof val === 'string' && val.length > 0),
    {
      message: 'Email cannot be an empty string',
    },
  );

// Gender validation
const genderSchema = z
  .enum(['male', 'female', 'other'], {
    errorMap: () => ({ message: 'Gender must be one of: male, female, other' }),
  })
  .nullable()
  .optional();

// SMS consent validation
const smsConsentSchema = z.enum(['opted_in', 'opted_out', 'unknown'], {
  errorMap: () => ({
    message: 'SMS consent must be one of: opted_in, opted_out, unknown',
  }),
});

// Birth date validation
const birthDateSchema = z
  .union([
    z
      .string()
      .trim()
      .datetime({
        message: 'Birth date must be a valid ISO 8601 datetime string',
      })
      .refine(
        date => {
          const birthDate = new Date(date);
          if (isNaN(birthDate.getTime())) {
            return false;
          }
          return birthDate <= new Date();
        },
        {
          message: 'Birth date cannot be in the future',
        },
      ),
    z.null(),
  ])
  .optional();

// Tags validation
const tagsSchema = z.array(z.string()).default([]);

/**
 * Create Contact Schema
 */
export const createContactSchema = z.object({
  firstName: z
    .union([
      z
        .string()
        .trim()
        .min(1, 'First name cannot be empty')
        .max(100, 'First name too long'),
      z.null(),
    ])
    .optional()
    .refine(
      val =>
        val === null ||
        val === undefined ||
        (typeof val === 'string' && val.length > 0),
      {
        message: 'First name cannot be an empty string',
      },
    ),
  lastName: z
    .union([
      z
        .string()
        .trim()
        .min(1, 'Last name cannot be empty')
        .max(100, 'Last name too long'),
      z.null(),
    ])
    .optional()
    .refine(
      val =>
        val === null ||
        val === undefined ||
        (typeof val === 'string' && val.length > 0),
      {
        message: 'Last name cannot be an empty string',
      },
    ),
  phoneE164: phoneE164Schema,
  email: emailSchema,
  gender: genderSchema,
  birthDate: birthDateSchema,
  smsConsent: smsConsentSchema.default('unknown'),
  tags: tagsSchema,
});

/**
 * Update Contact Schema (all fields optional)
 */
export const updateContactSchema = z
  .object({
    firstName: z
      .union([
        z
          .string()
          .trim()
          .min(1, 'First name cannot be empty')
          .max(100, 'First name too long'),
        z.null(),
      ])
      .optional()
      .refine(
        val =>
          val === null ||
          val === undefined ||
          (typeof val === 'string' && val.length > 0),
        {
          message: 'First name cannot be an empty string',
        },
      ),
    lastName: z
      .union([
        z
          .string()
          .trim()
          .min(1, 'Last name cannot be empty')
          .max(100, 'Last name too long'),
        z.null(),
      ])
      .optional()
      .refine(
        val =>
          val === null ||
          val === undefined ||
          (typeof val === 'string' && val.length > 0),
        {
          message: 'Last name cannot be an empty string',
        },
      ),
    phoneE164: phoneE164Schema.optional(),
    email: emailSchema,
    gender: genderSchema,
    birthDate: birthDateSchema,
    smsConsent: smsConsentSchema.optional(),
    tags: tagsSchema.optional(),
  })
  .refine(
    data => {
      // Filter out undefined and null values to check if at least one field is provided
      const definedFields = Object.entries(data).filter(
        ([_, value]) => value !== undefined && value !== null,
      );
      return definedFields.length > 0;
    },
    {
      message: 'At least one field must be provided for update',
    },
  );

/**
 * List Contacts Query Schema
 */
export const listContactsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
  filter: z
    .enum(['all', 'male', 'female', 'consented', 'nonconsented'])
    .default('all'),
  q: z.string().optional(),
  sortBy: z
    .enum(['createdAt', 'updatedAt', 'firstName', 'lastName', 'birthDate'])
    .default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  gender: genderSchema,
  smsConsent: smsConsentSchema.optional(),
  hasBirthDate: z.enum(['true', 'false']).optional(),
});

/**
 * Import Contacts Schema
 */
export const importContactsSchema = z.object({
  contacts: z
    .array(createContactSchema)
    .min(1, 'At least one contact is required')
    .max(1000, 'Maximum 1000 contacts per import'),
});

/**
 * Birthday Contacts Query Schema
 */
export const birthdayContactsQuerySchema = z.object({
  daysAhead: z.coerce.number().int().positive().max(365).default(7),
});

export default {
  createContactSchema,
  updateContactSchema,
  listContactsQuerySchema,
  importContactsSchema,
  birthdayContactsQuerySchema,
};
