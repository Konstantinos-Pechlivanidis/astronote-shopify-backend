import { shopifyApi, Session } from '@shopify/shopify-api';
import { logger } from '../utils/logger.js';
import prisma from './prisma.js';

let initialized = false;
let apiInstance = null;

export function initShopifyContext() {
  if (initialized) return apiInstance;
  const { SHOPIFY_API_KEY, SHOPIFY_API_SECRET, HOST } = process.env;
  if (!SHOPIFY_API_KEY || !SHOPIFY_API_SECRET || !HOST) {
    logger.warn('Shopify API configuration incomplete', {
      hasApiKey: !!SHOPIFY_API_KEY,
      hasApiSecret: !!SHOPIFY_API_SECRET,
      hasHost: !!HOST,
    });
  }

  // Initialize Shopify API instance
  try {
    apiInstance = shopifyApi({
      apiKey: SHOPIFY_API_KEY,
      apiSecretKey: SHOPIFY_API_SECRET,
      scopes: process.env.SCOPES?.split(',') || ['read_products'],
      hostName: HOST.replace(/^https?:\/\//, '').split('/')[0],
      apiVersion: '2024-04',
      isEmbeddedApp: true,
    });
    logger.info('Shopify API initialized', {
      hasApiKey: !!SHOPIFY_API_KEY,
      hasApiSecret: !!SHOPIFY_API_SECRET,
      hasHost: !!HOST,
    });
  } catch (error) {
    logger.error('Failed to initialize Shopify API', {
      error: error.message,
    });
  }

  initialized = true;
  return apiInstance;
}

export function diagnostics() {
  const { SHOPIFY_API_KEY, SHOPIFY_API_SECRET, SCOPES, HOST } = process.env;
  return {
    hasApiKey: !!SHOPIFY_API_KEY,
    hasApiSecret: !!SHOPIFY_API_SECRET,
    hasHost: !!HOST,
    scopesCount: (SCOPES || '').split(',').filter(Boolean).length,
    embedded: true,
    apiVersion: '2024-04',
  };
}

/**
 * Get Shopify session for a shop
 * Retrieves the access token from the database for the specific store
 * @param {string} shopDomain - Shop domain
 * @returns {Promise<Session>}
 */
export async function getShopifySession(shopDomain) {
  try {
    // Validate shopDomain before querying
    if (!shopDomain || typeof shopDomain !== 'string') {
      throw new Error(`Invalid shopDomain provided: ${shopDomain}`);
    }

    // ✅ Fetch store from database to get access token
    const store = await prisma.shop.findUnique({
      where: { shopDomain },
      select: { id: true, accessToken: true, shopDomain: true },
    });

    if (!store) {
      throw new Error(`Store not found for domain: ${shopDomain}`);
    }

    if (!store.accessToken || store.accessToken === 'pending') {
      logger.warn('Shopify access token not available', {
        shopDomain,
        storeId: store.id,
        accessTokenStatus: store.accessToken || 'missing',
      });
      throw new Error(
        `Shopify access token not available for store: ${shopDomain}. Please complete the app installation.`,
      );
    }

    // ✅ Create session with actual access token from database
    const session = new Session({
      id: `shopify_session_${shopDomain}`,
      shop: shopDomain,
      state: 'state',
      isOnline: false,
      accessToken: store.accessToken, // ✅ Use actual access token from database
    });

    logger.info('Shopify session created', {
      shopDomain,
      storeId: store.id,
      hasAccessToken: !!store.accessToken,
    });

    return session;
  } catch (error) {
    logger.error('Failed to get Shopify session', {
      shopDomain,
      error: error.message,
    });
    throw error;
  }
}

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

  // Check for GraphQL client in different possible locations
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
 * Normalize discount data to a consistent structure
 * @param {Object} node - Discount node from GraphQL response
 * @param {Object} discount - Discount codeDiscount object
 * @returns {Object} Normalized discount object
 */
function normalizeDiscountData(node, discount) {
  // Extract discount code
  const code = discount.codes?.edges?.[0]?.node?.code || 'N/A';

  // Determine discount type and value
  let type = 'unknown';
  let valueLabel = '';

  if (discount.__typename === 'DiscountCodeBasic') {
    // Check customerGets.value to determine discount value (fragments are nested in value field)
    if (discount.customerGets?.value) {
      const value = discount.customerGets.value;
      if (value.percentage !== undefined) {
        type = 'percentage';
        valueLabel = `${value.percentage}% off`;
      } else if (value.amount) {
        type = 'fixed_amount';
        const amount = value.amount.amount;
        const currency = value.amount.currencyCode;
        valueLabel = `${amount} ${currency} off`;
      }
    }
  } else if (discount.__typename === 'DiscountCodeBxgy') {
    type = 'buy_x_get_y';
    valueLabel = 'Buy X Get Y';
  } else if (discount.__typename === 'DiscountCodeFreeShipping') {
    type = 'free_shipping';
    valueLabel = 'Free shipping';
  }

  // Format validity label
  let validityLabel = '';
  if (discount.endsAt) {
    const endDate = new Date(discount.endsAt);
    if (!isNaN(endDate.getTime())) {
      validityLabel = `Valid until ${endDate.toLocaleDateString('en-US', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      })}`;
    }
  } else if (discount.startsAt) {
    const startDate = new Date(discount.startsAt);
    if (!isNaN(startDate.getTime()) && startDate > new Date()) {
      validityLabel = `Starts ${startDate.toLocaleDateString('en-US', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      })}`;
    }
  }

  // Check if expired
  const isExpired = discount.endsAt
    ? new Date(discount.endsAt) < new Date()
    : false;

  return {
    id: node.id,
    code,
    title: discount.title || 'Untitled Discount',
    type,
    valueLabel,
    validityLabel,
    status: discount.status || 'UNKNOWN',
    isActive: discount.status === 'ACTIVE' && !isExpired,
    isExpired,
    startsAt: discount.startsAt || null,
    endsAt: discount.endsAt || null,
    usageLimit: discount.usageLimit || null,
  };
}

/**
 * Get discount codes for a shop
 * @param {string} shopDomain - Shop domain
 * @returns {Promise<Array>}
 */
export async function getDiscountCodes(shopDomain) {
  try {
    const session = await getShopifySession(shopDomain);
    const api = initShopifyContext();
    const GraphqlClient = getGraphQLClient(api);

    // Create a GraphQL client
    const client = new GraphqlClient({ session });

    // GraphQL query to get discount codes
    // Fetches comprehensive discount data including type, value, validity, and status
    const query = `
      query getDiscountCodes($first: Int!) {
        codeDiscountNodes(first: $first) {
          edges {
            node {
              id
              codeDiscount {
                ... on DiscountCodeBasic {
                  title
                  codes(first: 1) {
                    edges {
                      node {
                        code
                      }
                    }
                  }
                  status
                  startsAt
                  endsAt
                  usageLimit
                  customerSelection {
                    ... on DiscountCustomerAll {
                      allCustomers
                    }
                    ... on DiscountCustomerSegments {
                      segments {
                        id
                      }
                    }
                  }
                  minimumRequirement {
                    ... on DiscountMinimumQuantity {
                      greaterThanOrEqualToQuantity
                    }
                    ... on DiscountMinimumSubtotal {
                      greaterThanOrEqualToSubtotal {
                        amount
                        currencyCode
                      }
                    }
                  }
                  customerGets {
                    value {
                    ... on DiscountPercentage {
                      percentage
                    }
                    ... on DiscountAmount {
                      amount {
                        amount
                        currencyCode
                        }
                      }
                    }
                  }
                }
                ... on DiscountCodeBxgy {
                  title
                  codes(first: 1) {
                    edges {
                      node {
                        code
                      }
                    }
                  }
                  status
                  startsAt
                  endsAt
                  usageLimit
                }
                ... on DiscountCodeFreeShipping {
                  title
                  codes(first: 1) {
                    edges {
                      node {
                        code
                      }
                    }
                  }
                  status
                  startsAt
                  endsAt
                  usageLimit
                }
              }
            }
          }
        }
      }
    `;

    const response = await client.query({
      data: {
        query,
        variables: { first: 50 },
      },
    });

    // Check for GraphQL errors in response
    if (response.body.errors && response.body.errors.length > 0) {
      const graphqlErrors = response.body.errors
        .map(err => err.message)
        .join('; ');
      logger.error('Shopify GraphQL errors in getDiscountCodes', {
        shopDomain,
        errors: response.body.errors,
        errorMessages: graphqlErrors,
      });
      throw new Error(`Shopify GraphQL error: ${graphqlErrors}`);
    }

    // Check if data exists
    if (!response.body.data || !response.body.data.codeDiscountNodes) {
      logger.error('Invalid response structure from Shopify GraphQL', {
        shopDomain,
        responseStructure: Object.keys(response.body),
      });
      throw new Error('Invalid response structure from Shopify API');
    }

    // Normalize discount data to a consistent structure
    const discountCodes = response.body.data.codeDiscountNodes.edges.map(
      edge => {
        const node = edge.node;
        const discount = node.codeDiscount;
        return normalizeDiscountData(node, discount);
      },
    );

    logger.info('Discount codes retrieved', {
      shopDomain,
      count: discountCodes.length,
    });

    return discountCodes;
  } catch (error) {
    logger.error('Failed to get discount codes', {
      shopDomain,
      error: error.message,
      stack: error.stack,
    });
    throw error;
  }
}

/**
 * Get a specific discount code by ID
 * @param {string} shopDomain - Shop domain
 * @param {string} discountId - Discount ID
 * @returns {Promise<Object>}
 */
export async function getDiscountCode(shopDomain, discountId) {
  try {
    const session = await getShopifySession(shopDomain);
    const api = initShopifyContext();
    const GraphqlClient = getGraphQLClient(api);

    const client = new GraphqlClient({ session });

    // Enhanced query to fetch comprehensive discount data
    const query = `
      query getDiscountCode($id: ID!) {
        codeDiscountNode(id: $id) {
          id
          codeDiscount {
            ... on DiscountCodeBasic {
              title
              codes(first: 1) {
                edges {
                  node {
                    code
                  }
                }
              }
              status
              startsAt
              endsAt
              usageLimit
              customerGets {
                value {
                  ... on DiscountPercentage {
                    percentage
                  }
                  ... on DiscountAmount {
                    amount {
                      amount
                      currencyCode
                    }
                  }
                }
              }
            }
            ... on DiscountCodeBxgy {
              title
              codes(first: 1) {
                edges {
                  node {
                    code
                  }
                }
              }
              status
              startsAt
              endsAt
              usageLimit
            }
            ... on DiscountCodeFreeShipping {
              title
              codes(first: 1) {
                edges {
                  node {
                    code
                  }
                }
              }
              status
              startsAt
              endsAt
              usageLimit
            }
          }
        }
      }
    `;

    const response = await client.query({
      data: {
        query,
        variables: { id: discountId },
      },
    });

    // Check for GraphQL errors in response
    if (response.body.errors && response.body.errors.length > 0) {
      const graphqlErrors = response.body.errors
        .map(err => err.message)
        .join('; ');
      logger.error('Shopify GraphQL errors in getDiscountCode', {
        shopDomain,
        discountId,
        errors: response.body.errors,
        errorMessages: graphqlErrors,
      });
      throw new Error(`Shopify GraphQL error: ${graphqlErrors}`);
    }

    // Check if data exists
    if (!response.body.data || !response.body.data.codeDiscountNode) {
      logger.error('Discount code not found or invalid response structure', {
        shopDomain,
        discountId,
        responseStructure: Object.keys(response.body),
      });
      throw new Error('Discount code not found');
    }

    const node = response.body.data.codeDiscountNode;
    const discount = node.codeDiscount;
    // Use the same normalization function for consistency
    return normalizeDiscountData(node, discount);
  } catch (error) {
    logger.error('Failed to get discount code', {
      shopDomain,
      discountId,
      error: error.message,
      stack: error.stack,
    });
    throw error;
  }
}

export default {
  initShopifyContext,
  diagnostics,
  getShopifySession,
  getDiscountCodes,
  getDiscountCode,
};
