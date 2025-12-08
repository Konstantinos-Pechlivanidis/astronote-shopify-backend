import { logger } from '../utils/logger.js';
import prisma from '../services/prisma.js';
import {
  queryEvents,
  getCustomerFromEvent,
  getOrderFromEvent,
  getFulfillmentFromEvent,
} from '../services/shopify-events.js';
import { shouldTriggerAutomation } from '../services/event-automation-mapper.js';
import {
  getMinOccurredAt,
  isEventProcessed,
  batchMarkEventsProcessed,
} from '../services/event-deduplication.js';
import { automationQueue } from '../queue/index.js';
import { getExpectedEventForAutomation } from '../services/event-automation-mapper.js';

/**
 * Process events for a single shop
 * @param {Object} shop - Shop object with id and shopDomain
 * @returns {Promise<Object>} Processing results
 */
async function processShopEvents(shop) {
  const results = {
    shopId: shop.id,
    shopDomain: shop.shopDomain,
    eventsProcessed: 0,
    automationsQueued: 0,
    errors: 0,
    details: [],
  };

  try {
    // Get active automations for this shop
    const activeAutomations = await prisma.userAutomation.findMany({
      where: {
        shopId: shop.id,
        isActive: true,
      },
      include: {
        automation: true,
      },
    });

    if (activeAutomations.length === 0) {
      logger.debug('No active automations for shop', {
        shopId: shop.id,
        shopDomain: shop.shopDomain,
      });
      return results;
    }

    // Get automation types we need to monitor
    const automationTypes = activeAutomations.map(
      ua => ua.automation.triggerEvent,
    );
    const uniqueAutomationTypes = [...new Set(automationTypes)];

    // Process each automation type
    for (const automationType of uniqueAutomationTypes) {
      try {
        // Get expected event configuration
        const eventConfig = getExpectedEventForAutomation(automationType);
        if (!eventConfig) {
          logger.warn('Unknown automation type, skipping', {
            shopId: shop.id,
            automationType,
          });
          continue;
        }

        // Get minimum occurredAt timestamp
        const minOccurredAt = await getMinOccurredAt(
          shop.id,
          automationType,
          10,
        );
        const maxOccurredAt = new Date();

        // Query events from Shopify
        const eventsResponse = await queryEvents(shop.shopDomain, {
          subjectTypes: eventConfig.subjectTypes,
          occurredAtMin: minOccurredAt,
          occurredAtMax: maxOccurredAt,
          first: 50,
        });

        const events = eventsResponse.edges.map(edge => edge.node);
        if (events.length === 0) {
          continue;
        }

        logger.info('Found events for shop', {
          shopId: shop.id,
          shopDomain: shop.shopDomain,
          automationType,
          eventCount: events.length,
        });

        // Process each event
        const processedEvents = [];
        for (const event of events) {
          try {
            // Check if event already processed
            const alreadyProcessed = await isEventProcessed(
              event.id,
              shop.id,
              automationType,
            );
            if (alreadyProcessed) {
              logger.debug('Event already processed, skipping', {
                eventId: event.id,
                shopId: shop.id,
                automationType,
              });
              continue;
            }

            // Get event data based on subject type
            const eventData = {};
            if (event.subjectType === 'CUSTOMER') {
              const customer = await getCustomerFromEvent(
                shop.shopDomain,
                event,
              );
              if (customer) {
                eventData.customer = customer;
              }
            } else if (event.subjectType === 'ORDER') {
              const order = await getOrderFromEvent(shop.shopDomain, event);
              if (order) {
                eventData.order = order;
              }
            } else if (event.subjectType === 'FULFILLMENT') {
              const fulfillment = await getFulfillmentFromEvent(
                shop.shopDomain,
                event,
              );
              if (fulfillment) {
                eventData.fulfillment = fulfillment;
              }
            }

            // Check if automation should be triggered
            if (!shouldTriggerAutomation(event, automationType, eventData)) {
              logger.debug('Event does not qualify for automation', {
                eventId: event.id,
                shopId: shop.id,
                automationType,
                subjectType: event.subjectType,
                action: event.action,
              });
              continue;
            }

            // Find the user automation
            const userAutomation = activeAutomations.find(
              ua => ua.automation.triggerEvent === automationType,
            );

            if (!userAutomation) {
              logger.warn('User automation not found for event', {
                eventId: event.id,
                shopId: shop.id,
                automationType,
              });
              continue;
            }

            // Find or create contact
            let contactId = null;
            if (eventData.customer) {
              // Find contact by email
              let contact = await prisma.contact.findFirst({
                where: {
                  shopId: shop.id,
                  email: eventData.customer.email,
                },
              });

              // Create contact if not exists
              if (!contact && eventData.customer.email) {
                contact = await prisma.contact.create({
                  data: {
                    shopId: shop.id,
                    email: eventData.customer.email,
                    firstName: eventData.customer.firstName || null,
                    lastName: eventData.customer.lastName || null,
                    phoneE164: eventData.customer.phone || null,
                    smsConsent: eventData.customer.hasSmsConsent
                      ? 'opted_in'
                      : 'unknown',
                  },
                });
                logger.info('Contact created from event', {
                  contactId: contact.id,
                  shopId: shop.id,
                  eventId: event.id,
                });
              }

              if (contact) {
                contactId = contact.id;

                // Update SMS consent if changed
                if (
                  eventData.customer.hasSmsConsent &&
                  contact.smsConsent !== 'opted_in'
                ) {
                  await prisma.contact.update({
                    where: { id: contact.id },
                    data: { smsConsent: 'opted_in' },
                  });
                }
              }
            } else if (eventData.order && eventData.order.customer) {
              // Find contact by order customer email
              let contact = await prisma.contact.findFirst({
                where: {
                  shopId: shop.id,
                  email: eventData.order.customer.email,
                },
              });

              if (!contact && eventData.order.customer.email) {
                contact = await prisma.contact.create({
                  data: {
                    shopId: shop.id,
                    email: eventData.order.customer.email,
                    firstName: eventData.order.customer.firstName || null,
                    lastName: eventData.order.customer.lastName || null,
                    phoneE164: eventData.order.customer.phone || null,
                    smsConsent: 'unknown',
                  },
                });
              }

              if (contact) {
                contactId = contact.id;
              }
            } else if (
              eventData.fulfillment &&
              eventData.fulfillment.order &&
              eventData.fulfillment.order.customer
            ) {
              // Find contact by fulfillment order customer email
              let contact = await prisma.contact.findFirst({
                where: {
                  shopId: shop.id,
                  email: eventData.fulfillment.order.customer.email,
                },
              });

              if (!contact && eventData.fulfillment.order.customer.email) {
                contact = await prisma.contact.create({
                  data: {
                    shopId: shop.id,
                    email: eventData.fulfillment.order.customer.email,
                    firstName:
                      eventData.fulfillment.order.customer.firstName || null,
                    lastName:
                      eventData.fulfillment.order.customer.lastName || null,
                    phoneE164:
                      eventData.fulfillment.order.customer.phone || null,
                    smsConsent: 'unknown',
                  },
                });
              }

              if (contact) {
                contactId = contact.id;
              }
            }

            if (!contactId) {
              logger.warn('Could not find or create contact for event', {
                eventId: event.id,
                shopId: shop.id,
                automationType,
              });
              continue;
            }

            // Prepare job data based on automation type
            const baseJobData = {
              shopId: shop.id,
              contactId,
              automationId: userAutomation.id,
            };

            let jobData;
            if (automationType === 'welcome') {
              jobData = {
                ...baseJobData,
                welcomeData: {
                  customerEmail: eventData.customer?.email,
                  customerName:
                    `${eventData.customer?.firstName || ''} ${eventData.customer?.lastName || ''}`.trim(),
                },
              };
            } else if (automationType === 'order_placed') {
              jobData = {
                ...baseJobData,
                orderData: {
                  orderNumber: eventData.order?.name,
                  customerEmail: eventData.order?.email,
                  customerName: eventData.order?.customer
                    ? `${eventData.order.customer.firstName || ''} ${eventData.order.customer.lastName || ''}`.trim()
                    : '',
                  lineItems: eventData.order?.lineItems || [],
                  totalPrice: eventData.order?.totalPrice,
                  currency: eventData.order?.currency,
                },
              };
            } else if (automationType === 'order_fulfilled') {
              jobData = {
                ...baseJobData,
                orderData: {
                  orderNumber: eventData.fulfillment?.order?.name,
                  customerEmail: eventData.fulfillment?.order?.email,
                  customerName: eventData.fulfillment?.order?.customer
                    ? `${eventData.fulfillment.order.customer.firstName || ''} ${eventData.fulfillment.order.customer.lastName || ''}`.trim()
                    : '',
                  fulfillmentStatus: eventData.fulfillment?.status,
                  trackingNumber: eventData.fulfillment?.trackingNumber,
                  trackingUrls: eventData.fulfillment?.trackingUrls || [],
                },
              };
            } else {
              jobData = baseJobData;
            }

            // Queue automation job
            const jobName =
              automationType === 'order_placed'
                ? 'order-confirmation'
                : automationType === 'order_fulfilled'
                  ? 'order-fulfilled'
                  : automationType === 'welcome'
                    ? 'welcome'
                    : automationType;

            await automationQueue.add(jobName, jobData, {
              jobId: `${automationType}-${shop.id}-${event.id}-${Date.now()}`,
              attempts: 3,
              backoff: {
                type: 'exponential',
                delay: 2000,
              },
            });

            processedEvents.push({
              id: event.id,
              occurredAt: event.occurredAt,
            });

            results.eventsProcessed++;
            results.automationsQueued++;
            results.details.push({
              eventId: event.id,
              automationType,
              contactId,
              status: 'queued',
            });

            logger.info('Automation queued from event', {
              shopId: shop.id,
              eventId: event.id,
              automationType,
              contactId,
            });
          } catch (eventError) {
            results.errors++;
            logger.error('Error processing event', {
              shopId: shop.id,
              eventId: event.id,
              automationType,
              error: eventError.message,
              stack: eventError.stack,
            });
          }
        }

        // Batch mark events as processed
        if (processedEvents.length > 0) {
          await batchMarkEventsProcessed(
            processedEvents,
            shop.id,
            automationType,
          );
        }
      } catch (automationTypeError) {
        results.errors++;
        logger.error('Error processing automation type', {
          shopId: shop.id,
          automationType,
          error: automationTypeError.message,
          stack: automationTypeError.stack,
        });
      }
    }
  } catch (error) {
    logger.error('Error processing shop events', {
      shopId: shop.id,
      shopDomain: shop.shopDomain,
      error: error.message,
      stack: error.stack,
    });
    results.errors++;
  }

  return results;
}

/**
 * Process events for all active shops
 * @returns {Promise<Object>} Overall processing results
 */
export async function processAllShopEvents() {
  try {
    logger.info('Starting event polling for all shops');

    // Get all active shops
    const shops = await prisma.shop.findMany({
      where: {
        status: 'active',
        accessToken: {
          not: null,
        },
      },
      select: {
        id: true,
        shopDomain: true,
      },
    });

    if (shops.length === 0) {
      logger.info('No active shops found for event polling');
      return {
        shopsProcessed: 0,
        totalEventsProcessed: 0,
        totalAutomationsQueued: 0,
        totalErrors: 0,
      };
    }

    logger.info('Processing events for shops', {
      shopCount: shops.length,
    });

    const overallResults = {
      shopsProcessed: 0,
      totalEventsProcessed: 0,
      totalAutomationsQueued: 0,
      totalErrors: 0,
      shopResults: [],
    };

    // Process each shop
    for (const shop of shops) {
      try {
        const shopResults = await processShopEvents(shop);
        overallResults.shopsProcessed++;
        overallResults.totalEventsProcessed += shopResults.eventsProcessed;
        overallResults.totalAutomationsQueued += shopResults.automationsQueued;
        overallResults.totalErrors += shopResults.errors;
        overallResults.shopResults.push(shopResults);
      } catch (shopError) {
        overallResults.totalErrors++;
        logger.error('Error processing shop', {
          shopId: shop.id,
          shopDomain: shop.shopDomain,
          error: shopError.message,
        });
      }
    }

    logger.info('Event polling completed', {
      shopsProcessed: overallResults.shopsProcessed,
      totalEventsProcessed: overallResults.totalEventsProcessed,
      totalAutomationsQueued: overallResults.totalAutomationsQueued,
      totalErrors: overallResults.totalErrors,
    });

    return overallResults;
  } catch (error) {
    logger.error('Error in processAllShopEvents', {
      error: error.message,
      stack: error.stack,
    });
    throw error;
  }
}

/**
 * Start periodic event polling
 * This should be called on application startup
 */
export function startEventPoller() {
  // Skip in test mode
  if (process.env.NODE_ENV === 'test' && process.env.SKIP_QUEUES === 'true') {
    logger.info('Skipping event poller in test mode');
    return;
  }

  // Check if event polling is enabled
  const pollingEnabled = process.env.EVENT_POLLING_ENABLED !== 'false';
  if (!pollingEnabled) {
    logger.info('Event polling is disabled via environment variable');
    return;
  }

  // Polling interval (default: 5 minutes)
  const intervalMinutes = parseInt(
    process.env.EVENT_POLLING_INTERVAL || '5',
    10,
  );
  const INTERVAL_MS = intervalMinutes * 60 * 1000;

  // Initial delay of 1 minute to let the app fully start
  setTimeout(() => {
    processNextPoll();
  }, 60000); // 1 minute

  function processNextPoll() {
    try {
      processAllShopEvents()
        .then(result => {
          if (
            result.totalEventsProcessed > 0 ||
            result.totalAutomationsQueued > 0
          ) {
            logger.info('Event polling completed', result);
          }
        })
        .catch(error => {
          logger.error('Error in event poller', {
            error: error.message,
          });
        });

      // Schedule next poll
      setTimeout(processNextPoll, INTERVAL_MS);
    } catch (error) {
      logger.error('Failed to process event poll', {
        error: error.message,
      });
      // Retry after interval if processing fails
      setTimeout(processNextPoll, INTERVAL_MS);
    }
  }

  logger.info('Event poller started', {
    interval: `${intervalMinutes} minutes`,
    intervalMs: INTERVAL_MS,
  });
}

export default {
  processAllShopEvents,
  processShopEvents,
  startEventPoller,
};
