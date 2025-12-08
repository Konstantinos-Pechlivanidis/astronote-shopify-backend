import { logger } from '../utils/logger.js';
import { getShopifySession, initShopifyContext } from './shopify.js';

/**
 * Get GraphQL client from Shopify API instance
 * @param {Object} api - Shopify API instance
 * @returns {Class} GraphQL Client class
 * @throws {Error} If GraphQL client not found
 */
function getGraphQLClient(api) {
  if (!api) {
    logger.error('Shopify API not initialized');
    throw new Error(
      'Shopify API not initialized. Please check API configuration.',
    );
  }

  let GraphqlClient = null;
  if (api.clients && api.clients.Graphql) {
    GraphqlClient = api.clients.Graphql;
  } else if (api.clients && api.clients.graphql) {
    GraphqlClient = api.clients.graphql;
  } else if (api.Graphql) {
    GraphqlClient = api.Graphql;
  } else if (api.graphql) {
    GraphqlClient = api.graphql;
  }

  if (!GraphqlClient) {
    logger.error('Shopify API GraphQL client not available', {
      hasApi: !!api,
      hasClients: !!(api && api.clients),
      apiKeys: api ? Object.keys(api) : [],
      clientsKeys: api && api.clients ? Object.keys(api.clients) : [],
    });
    throw new Error(
      'Shopify API GraphQL client not available. Please check API initialization.',
    );
  }

  return GraphqlClient;
}

/**
 * Query Shopify Events API
 * @param {string} shopDomain - Shop domain
 * @param {Object} filters - Filter options
 * @param {string[]} filters.subjectTypes - Array of subject types (e.g., ['CUSTOMER', 'ORDER', 'FULFILLMENT'])
 * @param {Date} filters.occurredAtMin - Minimum occurredAt timestamp
 * @param {Date} filters.occurredAtMax - Maximum occurredAt timestamp
 * @param {number} filters.first - Number of events to fetch (default: 50)
 * @param {string} filters.after - Cursor for pagination
 * @returns {Promise<Object>} Events response with edges and pageInfo
 */
export async function queryEvents(shopDomain, filters = {}) {
  try {
    const session = await getShopifySession(shopDomain);
    const api = initShopifyContext();
    const GraphqlClient = getGraphQLClient(api);

    const client = new GraphqlClient({ session });

    const {
      subjectTypes = [],
      occurredAtMin,
      occurredAtMax,
      first = 50,
      after = null,
    } = filters;

    // Build filter variables for GraphQL query
    const filterVariables = {};
    if (subjectTypes.length > 0) {
      filterVariables.subjectTypes = subjectTypes;
    }
    if (occurredAtMin) {
      filterVariables.occurredAtMin = occurredAtMin.toISOString();
    }
    if (occurredAtMax) {
      filterVariables.occurredAtMax = occurredAtMax.toISOString();
    }

    // Build filter string for query
    const filterParts = [];
    if (subjectTypes.length > 0) {
      filterParts.push('subjectTypes: $subjectTypes');
    }
    if (occurredAtMin || occurredAtMax) {
      const occurredAtParts = [];
      if (occurredAtMin) {
        occurredAtParts.push('min: $occurredAtMin');
      }
      if (occurredAtMax) {
        occurredAtParts.push('max: $occurredAtMax');
      }
      filterParts.push(`occurredAt: { ${occurredAtParts.join(', ')} }`);
    }

    const filterString =
      filterParts.length > 0 ? `, filter: { ${filterParts.join(', ')} }` : '';

    const query = `
      query getEvents($first: Int!, $after: String${subjectTypes.length > 0 ? ', $subjectTypes: [EventSubjectType!]' : ''}${occurredAtMin ? ', $occurredAtMin: DateTime' : ''}${occurredAtMax ? ', $occurredAtMax: DateTime' : ''}) {
        events(first: $first, after: $after${filterString}) {
          edges {
            node {
              id
              occurredAt
              subjectType
              subjectId
              ... on BasicEvent {
                action
                message
                arguments
                subjectId
                subjectType
              }
            }
            cursor
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    `;

    const variables = {
      first,
      ...(after && { after }),
      ...filterVariables,
    };

    const response = await client.query({
      data: {
        query,
        variables,
      },
    });

    // Check for GraphQL errors
    if (response.body.errors && response.body.errors.length > 0) {
      const graphqlErrors = response.body.errors
        .map(err => err.message)
        .join('; ');
      logger.error('Shopify GraphQL errors in queryEvents', {
        shopDomain,
        errors: response.body.errors,
        errorMessages: graphqlErrors,
      });
      throw new Error(`Shopify GraphQL error: ${graphqlErrors}`);
    }

    if (!response.body.data || !response.body.data.events) {
      logger.error('Invalid response structure from Shopify Events API', {
        shopDomain,
        responseStructure: Object.keys(response.body),
      });
      throw new Error('Invalid response structure from Shopify Events API');
    }

    logger.info('Events queried successfully', {
      shopDomain,
      count: response.body.data.events.edges.length,
      hasNextPage: response.body.data.events.pageInfo.hasNextPage,
    });

    return response.body.data.events;
  } catch (error) {
    logger.error('Failed to query events', {
      shopDomain,
      filters,
      error: error.message,
      stack: error.stack,
    });
    throw error;
  }
}

/**
 * Get full event details by ID
 * @param {string} shopDomain - Shop domain
 * @param {string} eventId - Event GID
 * @returns {Promise<Object>} Full event details
 */
export async function getEventDetails(shopDomain, eventId) {
  try {
    const session = await getShopifySession(shopDomain);
    const api = initShopifyContext();
    const GraphqlClient = getGraphQLClient(api);

    const client = new GraphqlClient({ session });

    const query = `
      query getEvent($id: ID!) {
        event(id: $id) {
          id
          occurredAt
          subjectType
          subjectId
          ... on BasicEvent {
            action
            message
            arguments
            subjectId
            subjectType
            additionalContent
          }
        }
      }
    `;

    const response = await client.query({
      data: {
        query,
        variables: { id: eventId },
      },
    });

    if (response.body.errors && response.body.errors.length > 0) {
      const graphqlErrors = response.body.errors
        .map(err => err.message)
        .join('; ');
      logger.error('Shopify GraphQL errors in getEventDetails', {
        shopDomain,
        eventId,
        errors: response.body.errors,
        errorMessages: graphqlErrors,
      });
      throw new Error(`Shopify GraphQL error: ${graphqlErrors}`);
    }

    if (!response.body.data || !response.body.data.event) {
      logger.warn('Event not found', {
        shopDomain,
        eventId,
      });
      return null;
    }

    return response.body.data.event;
  } catch (error) {
    logger.error('Failed to get event details', {
      shopDomain,
      eventId,
      error: error.message,
      stack: error.stack,
    });
    throw error;
  }
}

/**
 * Get customer data from customer event
 * @param {string} shopDomain - Shop domain
 * @param {Object} event - Event object with subjectId
 * @returns {Promise<Object>} Customer data
 */
export async function getCustomerFromEvent(shopDomain, event) {
  try {
    if (!event.subjectId || event.subjectType !== 'CUSTOMER') {
      throw new Error('Event is not a customer event');
    }

    const session = await getShopifySession(shopDomain);
    const api = initShopifyContext();
    const GraphqlClient = getGraphQLClient(api);

    const client = new GraphqlClient({ session });

    const query = `
      query getCustomer($id: ID!) {
        customer(id: $id) {
          id
          email
          firstName
          lastName
          phone
          smsMarketingConsent {
            marketingState
            marketingOptInLevel
            consentUpdatedAt
          }
          defaultAddress {
            phone
          }
        }
      }
    `;

    const response = await client.query({
      data: {
        query,
        variables: { id: event.subjectId },
      },
    });

    if (response.body.errors && response.body.errors.length > 0) {
      const graphqlErrors = response.body.errors
        .map(err => err.message)
        .join('; ');
      logger.error('Shopify GraphQL errors in getCustomerFromEvent', {
        shopDomain,
        eventId: event.id,
        subjectId: event.subjectId,
        errors: response.body.errors,
        errorMessages: graphqlErrors,
      });
      throw new Error(`Shopify GraphQL error: ${graphqlErrors}`);
    }

    if (!response.body.data || !response.body.data.customer) {
      logger.warn('Customer not found for event', {
        shopDomain,
        eventId: event.id,
        subjectId: event.subjectId,
      });
      return null;
    }

    const customer = response.body.data.customer;

    // Check SMS marketing consent
    const smsConsent =
      customer.smsMarketingConsent?.marketingState || 'NOT_SUBSCRIBED';
    const hasSmsConsent = smsConsent === 'SUBSCRIBED';

    return {
      id: customer.id,
      email: customer.email,
      firstName: customer.firstName,
      lastName: customer.lastName,
      phone: customer.phone || customer.defaultAddress?.phone || null,
      smsMarketingConsent: smsConsent,
      hasSmsConsent,
      consentUpdatedAt: customer.smsMarketingConsent?.consentUpdatedAt || null,
    };
  } catch (error) {
    logger.error('Failed to get customer from event', {
      shopDomain,
      eventId: event.id,
      subjectId: event.subjectId,
      error: error.message,
      stack: error.stack,
    });
    throw error;
  }
}

/**
 * Get order data from order event
 * @param {string} shopDomain - Shop domain
 * @param {Object} event - Event object with subjectId
 * @returns {Promise<Object>} Order data
 */
export async function getOrderFromEvent(shopDomain, event) {
  try {
    if (!event.subjectId || event.subjectType !== 'ORDER') {
      throw new Error('Event is not an order event');
    }

    const session = await getShopifySession(shopDomain);
    const api = initShopifyContext();
    const GraphqlClient = getGraphQLClient(api);

    const client = new GraphqlClient({ session });

    const query = `
      query getOrder($id: ID!) {
        order(id: $id) {
          id
          name
          email
          totalPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          customer {
            id
            email
            firstName
            lastName
            phone
          }
          lineItems(first: 10) {
            edges {
              node {
                title
                quantity
              }
            }
          }
        }
      }
    `;

    const response = await client.query({
      data: {
        query,
        variables: { id: event.subjectId },
      },
    });

    if (response.body.errors && response.body.errors.length > 0) {
      const graphqlErrors = response.body.errors
        .map(err => err.message)
        .join('; ');
      logger.error('Shopify GraphQL errors in getOrderFromEvent', {
        shopDomain,
        eventId: event.id,
        subjectId: event.subjectId,
        errors: response.body.errors,
        errorMessages: graphqlErrors,
      });
      throw new Error(`Shopify GraphQL error: ${graphqlErrors}`);
    }

    if (!response.body.data || !response.body.data.order) {
      logger.warn('Order not found for event', {
        shopDomain,
        eventId: event.id,
        subjectId: event.subjectId,
      });
      return null;
    }

    const order = response.body.data.order;

    return {
      id: order.id,
      name: order.name,
      email: order.email,
      totalPrice: order.totalPriceSet?.shopMoney?.amount || '0',
      currency: order.totalPriceSet?.shopMoney?.currencyCode || 'USD',
      customer: order.customer
        ? {
          id: order.customer.id,
          email: order.customer.email,
          firstName: order.customer.firstName,
          lastName: order.customer.lastName,
          phone: order.customer.phone,
        }
        : null,
      lineItems:
        order.lineItems?.edges?.map(edge => ({
          title: edge.node.title,
          quantity: edge.node.quantity,
        })) || [],
    };
  } catch (error) {
    logger.error('Failed to get order from event', {
      shopDomain,
      eventId: event.id,
      subjectId: event.subjectId,
      error: error.message,
      stack: error.stack,
    });
    throw error;
  }
}

/**
 * Get fulfillment data from fulfillment event
 * @param {string} shopDomain - Shop domain
 * @param {Object} event - Event object with subjectId
 * @returns {Promise<Object>} Fulfillment data with order info
 */
export async function getFulfillmentFromEvent(shopDomain, event) {
  try {
    if (!event.subjectId || event.subjectType !== 'FULFILLMENT') {
      throw new Error('Event is not a fulfillment event');
    }

    const session = await getShopifySession(shopDomain);
    const api = initShopifyContext();
    const GraphqlClient = getGraphQLClient(api);

    const client = new GraphqlClient({ session });

    const query = `
      query getFulfillment($id: ID!) {
        fulfillment(id: $id) {
          id
          status
          trackingInfo {
            number
            url
          }
          order {
            id
            name
            email
            customer {
              id
              email
              firstName
              lastName
              phone
            }
          }
        }
      }
    `;

    const response = await client.query({
      data: {
        query,
        variables: { id: event.subjectId },
      },
    });

    if (response.body.errors && response.body.errors.length > 0) {
      const graphqlErrors = response.body.errors
        .map(err => err.message)
        .join('; ');
      logger.error('Shopify GraphQL errors in getFulfillmentFromEvent', {
        shopDomain,
        eventId: event.id,
        subjectId: event.subjectId,
        errors: response.body.errors,
        errorMessages: graphqlErrors,
      });
      throw new Error(`Shopify GraphQL error: ${graphqlErrors}`);
    }

    if (!response.body.data || !response.body.data.fulfillment) {
      logger.warn('Fulfillment not found for event', {
        shopDomain,
        eventId: event.id,
        subjectId: event.subjectId,
      });
      return null;
    }

    const fulfillment = response.body.data.fulfillment;
    const order = fulfillment.order;

    return {
      id: fulfillment.id,
      status: fulfillment.status,
      trackingNumber: fulfillment.trackingInfo?.number || null,
      trackingUrls: fulfillment.trackingInfo?.url
        ? [fulfillment.trackingInfo.url]
        : [],
      order: order
        ? {
          id: order.id,
          name: order.name,
          email: order.email,
          customer: order.customer
            ? {
              id: order.customer.id,
              email: order.customer.email,
              firstName: order.customer.firstName,
              lastName: order.customer.lastName,
              phone: order.customer.phone,
            }
            : null,
        }
        : null,
    };
  } catch (error) {
    logger.error('Failed to get fulfillment from event', {
      shopDomain,
      eventId: event.id,
      subjectId: event.subjectId,
      error: error.message,
      stack: error.stack,
    });
    throw error;
  }
}

export default {
  queryEvents,
  getEventDetails,
  getCustomerFromEvent,
  getOrderFromEvent,
  getFulfillmentFromEvent,
};
