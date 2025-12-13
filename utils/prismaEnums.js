/**
 * Prisma Enum Constants
 *
 * Centralized enum constants exported from Prisma client.
 * Use these instead of string literals for type safety and consistency.
 *
 * @example
 * import { CampaignStatus, ScheduleType } from '../utils/prismaEnums.js';
 *
 * if (campaign.status === CampaignStatus.sending) { ... }
 * status: { in: [CampaignStatus.draft, CampaignStatus.scheduled] }
 */

// Prisma enums are not directly available on Prisma object
// Define them as constants matching the Prisma schema exactly

// Campaign enums
export const CampaignStatus = {
  draft: 'draft',
  scheduled: 'scheduled',
  sending: 'sending',
  sent: 'sent',
  failed: 'failed',
  cancelled: 'cancelled',
};

export const CampaignPriority = {
  low: 'low',
  normal: 'normal',
  high: 'high',
  urgent: 'urgent',
};

// Schedule type enums
export const ScheduleType = {
  immediate: 'immediate',
  scheduled: 'scheduled',
  recurring: 'recurring',
};

// Contact enums
export const SmsConsent = {
  opted_in: 'opted_in',
  opted_out: 'opted_out',
  unknown: 'unknown',
};

// Message enums
export const MessageDirection = {
  outbound: 'outbound',
  inbound: 'inbound',
};

export const MessageStatus = {
  queued: 'queued',
  sent: 'sent',
  delivered: 'delivered',
  failed: 'failed',
  received: 'received',
};

// Transaction enums
export const TransactionType = {
  purchase: 'purchase',
  debit: 'debit',
  credit: 'credit',
  refund: 'refund',
  adjustment: 'adjustment',
};

export const CreditTxnType = {
  credit: 'credit',
  debit: 'debit',
  refund: 'refund',
};

// Subscription enums
export const SubscriptionPlanType = {
  starter: 'starter',
  pro: 'pro',
};

export const SubscriptionStatus = {
  active: 'active',
  inactive: 'inactive',
  cancelled: 'cancelled',
};

// Automation enums
export const AutomationTrigger = {
  welcome: 'welcome',
  abandoned_cart: 'abandoned_cart',
  order_confirmation: 'order_confirmation',
  shipping_update: 'shipping_update',
  delivery_confirmation: 'delivery_confirmation',
  review_request: 'review_request',
  reorder_reminder: 'reorder_reminder',
  birthday: 'birthday',
  customer_inactive: 'customer_inactive',
  cart_abandoned: 'cart_abandoned',
  order_placed: 'order_placed',
  order_fulfilled: 'order_fulfilled',
};

// Payment enums
export const PaymentStatus = {
  pending: 'pending',
  paid: 'paid',
  failed: 'failed',
  refunded: 'refunded',
};

/**
 * Helper function to get all enum values as an array
 * @param {Object} enumObject - The enum object (e.g., CampaignStatus)
 * @returns {Array<string>} Array of enum values
 */
export function getEnumValues(enumObject) {
  return Object.values(enumObject);
}

/**
 * Helper function to check if a value is a valid enum value
 * @param {Object} enumObject - The enum object (e.g., CampaignStatus)
 * @param {string} value - The value to check
 * @returns {boolean} True if value is a valid enum value
 */
export function isValidEnumValue(enumObject, value) {
  return Object.values(enumObject).includes(value);
}

/**
 * Enum value mappings for easy reference
 * These can be used for validation, documentation, or UI display
 */
export const EnumValues = {
  CampaignStatus: {
    draft: 'draft',
    scheduled: 'scheduled',
    sending: 'sending',
    sent: 'sent',
    failed: 'failed',
    cancelled: 'cancelled',
  },
  CampaignPriority: {
    low: 'low',
    normal: 'normal',
    high: 'high',
    urgent: 'urgent',
  },
  ScheduleType: {
    immediate: 'immediate',
    scheduled: 'scheduled',
    recurring: 'recurring',
  },
  SmsConsent: {
    opted_in: 'opted_in',
    opted_out: 'opted_out',
    unknown: 'unknown',
  },
  MessageDirection: {
    outbound: 'outbound',
    inbound: 'inbound',
  },
  MessageStatus: {
    queued: 'queued',
    sent: 'sent',
    delivered: 'delivered',
    failed: 'failed',
    received: 'received',
  },
  TransactionType: {
    purchase: 'purchase',
    debit: 'debit',
    credit: 'credit',
    refund: 'refund',
    adjustment: 'adjustment',
  },
  SubscriptionPlanType: {
    starter: 'starter',
    pro: 'pro',
  },
  SubscriptionStatus: {
    active: 'active',
    inactive: 'inactive',
    cancelled: 'cancelled',
  },
  CreditTxnType: {
    credit: 'credit',
    debit: 'debit',
    refund: 'refund',
  },
  AutomationTrigger: {
    welcome: 'welcome',
    abandoned_cart: 'abandoned_cart',
    order_confirmation: 'order_confirmation',
    shipping_update: 'shipping_update',
    delivery_confirmation: 'delivery_confirmation',
    review_request: 'review_request',
    reorder_reminder: 'reorder_reminder',
    birthday: 'birthday',
    customer_inactive: 'customer_inactive',
    cart_abandoned: 'cart_abandoned',
    order_placed: 'order_placed',
    order_fulfilled: 'order_fulfilled',
  },
  PaymentStatus: {
    pending: 'pending',
    paid: 'paid',
    failed: 'failed',
    refunded: 'refunded',
  },
};
