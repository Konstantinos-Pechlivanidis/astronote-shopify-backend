import { logger } from '../utils/logger.js';

/**
 * Map Shopify event to automation type(s)
 * @param {Object} event - Shopify event object
 * @returns {string[]} Array of automation types that should be triggered
 */
export function mapEventToAutomationType(event) {
  const automationTypes = [];

  if (!event || !event.subjectType) {
    return automationTypes;
  }

  const { subjectType, action } = event;

  // Customer events -> welcome automation
  if (subjectType === 'CUSTOMER') {
    if (action === 'created' || action === 'updated') {
      automationTypes.push('welcome');
    }
  }

  // Order events -> order_placed automation
  if (subjectType === 'ORDER') {
    if (action === 'created' || action === 'confirmed') {
      automationTypes.push('order_placed');
    }
  }

  // Fulfillment events -> order_fulfilled automation
  if (subjectType === 'FULFILLMENT') {
    if (action === 'created' || action === 'updated') {
      automationTypes.push('order_fulfilled');
    }
  }

  logger.debug('Mapped event to automation types', {
    eventId: event.id,
    subjectType,
    action,
    automationTypes,
  });

  return automationTypes;
}

/**
 * Extract relevant data from event for automation
 * @param {Object} event - Shopify event object
 * @param {string} shopDomain - Shop domain
 * @param {Object} eventData - Additional event data (customer, order, fulfillment)
 * @returns {Object} Extracted data for automation
 */
export function extractEventData(event, shopDomain, eventData = {}) {
  const { subjectType, action } = event;
  const extracted = {
    eventId: event.id,
    occurredAt: event.occurredAt,
    subjectType,
    action,
    shopDomain,
  };

  // Extract customer data for welcome automation
  if (subjectType === 'CUSTOMER' && eventData.customer) {
    extracted.customer = {
      id: eventData.customer.id,
      email: eventData.customer.email,
      firstName: eventData.customer.firstName,
      lastName: eventData.customer.lastName,
      phone: eventData.customer.phone,
      smsMarketingConsent: eventData.customer.smsMarketingConsent,
      hasSmsConsent: eventData.customer.hasSmsConsent,
    };
  }

  // Extract order data for order_placed automation
  if (subjectType === 'ORDER' && eventData.order) {
    extracted.order = {
      id: eventData.order.id,
      name: eventData.order.name,
      email: eventData.order.email,
      totalPrice: eventData.order.totalPrice,
      currency: eventData.order.currency,
      customer: eventData.order.customer,
      lineItems: eventData.order.lineItems,
    };
  }

  // Extract fulfillment data for order_fulfilled automation
  if (subjectType === 'FULFILLMENT' && eventData.fulfillment) {
    extracted.fulfillment = {
      id: eventData.fulfillment.id,
      status: eventData.fulfillment.status,
      trackingNumber: eventData.fulfillment.trackingNumber,
      trackingUrls: eventData.fulfillment.trackingUrls,
      order: eventData.fulfillment.order,
    };
  }

  return extracted;
}

/**
 * Check if event should trigger automation
 * @param {Object} event - Shopify event object
 * @param {string} automationType - Automation type to check
 * @param {Object} eventData - Additional event data (customer, order, fulfillment)
 * @returns {boolean} Whether automation should be triggered
 */
export function shouldTriggerAutomation(event, automationType, eventData = {}) {
  if (!event || !automationType) {
    return false;
  }

  const { subjectType, action } = event;

  // Welcome automation: requires customer with SMS consent
  if (automationType === 'welcome') {
    if (
      subjectType !== 'CUSTOMER' ||
      (action !== 'created' && action !== 'updated')
    ) {
      return false;
    }
    // Check if customer has SMS consent
    if (eventData.customer && eventData.customer.hasSmsConsent) {
      return true;
    }
    return false;
  }

  // Order placed automation: requires order event
  if (automationType === 'order_placed') {
    if (
      subjectType !== 'ORDER' ||
      (action !== 'created' && action !== 'confirmed')
    ) {
      return false;
    }
    // Check if order has customer
    if (eventData.order && eventData.order.customer) {
      return true;
    }
    return false;
  }

  // Order fulfilled automation: requires fulfillment event with success status
  if (automationType === 'order_fulfilled') {
    if (
      subjectType !== 'FULFILLMENT' ||
      (action !== 'created' && action !== 'updated')
    ) {
      return false;
    }
    // Check if fulfillment is actually fulfilled (Shopify uses 'SUCCESS' status)
    if (eventData.fulfillment && eventData.fulfillment.status === 'SUCCESS') {
      return true;
    }
    return false;
  }

  return false;
}

/**
 * Get automation trigger event from automation type
 * @param {string} automationType - Automation type
 * @returns {Object} Expected event configuration
 */
export function getExpectedEventForAutomation(automationType) {
  const eventConfigs = {
    welcome: {
      subjectTypes: ['CUSTOMER'],
      actions: ['created', 'updated'],
    },
    order_placed: {
      subjectTypes: ['ORDER'],
      actions: ['created', 'confirmed'],
    },
    order_fulfilled: {
      subjectTypes: ['FULFILLMENT'],
      actions: ['created', 'updated'],
    },
  };

  return eventConfigs[automationType] || null;
}

export default {
  mapEventToAutomationType,
  extractEventData,
  shouldTriggerAutomation,
  getExpectedEventForAutomation,
};
