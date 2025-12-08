/**
 * Standardized Response Helpers
 * Ensures consistency across all API endpoints
 */

/**
 * Standard success response
 * @param {Object} res - Express response object
 * @param {*} data - Response data
 * @param {string} message - Optional success message
 * @param {number} statusCode - HTTP status code (default: 200)
 */
export function sendSuccess(res, data, message = null, statusCode = 200) {
  const response = {
    success: true,
    data,
  };

  if (message) {
    response.message = message;
  }

  return res.status(statusCode).json(response);
}

/**
 * Standard created response (201)
 * @param {Object} res - Express response object
 * @param {*} data - Response data
 * @param {string} message - Optional success message
 */
export function sendCreated(res, data, message = null) {
  return sendSuccess(res, data, message, 201);
}

/**
 * Standard paginated response
 * @param {Object} res - Express response object
 * @param {Array} items - Array of items
 * @param {Object} pagination - Pagination metadata
 * @param {Object} meta - Additional metadata (optional, can include custom item names like 'contacts', 'campaigns', etc.)
 */
export function sendPaginated(res, items, pagination, meta = {}) {
  // Standardize pagination format
  const standardizedPagination = {
    page: pagination.page || pagination.currentPage || 1,
    pageSize:
      pagination.pageSize || pagination.limit || pagination.perPage || 20,
    total: pagination.total || pagination.totalCount || 0,
    totalPages:
      pagination.totalPages ||
      pagination.pages ||
      Math.ceil(
        (pagination.total || pagination.totalCount || 0) /
          (pagination.pageSize || pagination.limit || pagination.perPage || 20),
      ),
    hasNextPage:
      pagination.hasNextPage !== undefined
        ? pagination.hasNextPage
        : (pagination.page || pagination.currentPage || 1) <
          (pagination.totalPages ||
            pagination.pages ||
            Math.ceil(
              (pagination.total || pagination.totalCount || 0) /
                (pagination.pageSize ||
                  pagination.limit ||
                  pagination.perPage ||
                  20),
            )),
    hasPrevPage:
      pagination.hasPrevPage !== undefined
        ? pagination.hasPrevPage
        : (pagination.page || pagination.currentPage || 1) > 1,
  };

  // Support custom item names in meta (e.g., { contacts: [...], filters: {...} })
  // If meta contains arrays like 'contacts', 'campaigns', include them in response
  const itemKeys = [
    'contacts',
    'campaigns',
    'templates',
    'transactions',
    'discounts',
    'audiences',
  ];
  const responseData = { ...meta };

  // Add items array (always include, even if empty)
  // This is the primary array that validators look for
  // Use the items parameter first, but if empty and we have a custom array in meta, use that
  if (items && items.length > 0) {
    responseData.items = items;
  } else {
    // Check if any custom array exists in meta
    let foundArray = null;
    for (const key of itemKeys) {
      if (Array.isArray(meta[key]) && meta[key].length > 0) {
        foundArray = meta[key];
        break;
      }
    }
    responseData.items = foundArray || items || [];
  }

  // Also include custom item names if they exist in meta (for backward compatibility)
  for (const key of itemKeys) {
    if (Array.isArray(meta[key])) {
      responseData[key] = meta[key];
    }
  }

  const response = {
    success: true,
    data: {
      ...responseData,
      pagination: standardizedPagination,
    },
  };

  return res.json(response);
}

/**
 * Standard error response
 * Supports multiple signatures for backward compatibility:
 * - sendError(res, statusCode, code, message, data) - New format
 * - sendError(res, error, message, statusCode) - Legacy format
 *
 * @param {Object} res - Express response object
 * @param {number|Object|string} statusCodeOrError - Status code (new) or error object/string (legacy)
 * @param {string} codeOrMessage - Error code (new) or message (legacy)
 * @param {string} messageOrStatusCode - Message (new) or status code (legacy)
 * @param {Object} dataOrMessage - Additional data (new) or message (legacy)
 */
export function sendError(
  res,
  statusCodeOrError,
  codeOrMessage,
  messageOrStatusCode,
  dataOrMessage,
) {
  // Detect which signature is being used
  let statusCode, code, message, data;

  if (typeof statusCodeOrError === 'number') {
    // New format: sendError(res, statusCode, code, message, data)
    statusCode = statusCodeOrError;
    code = codeOrMessage || 'error';
    message = messageOrStatusCode || 'An error occurred';
    data = dataOrMessage;
  } else {
    // Legacy format: sendError(res, error, message, statusCode)
    const error = statusCodeOrError;
    statusCode = messageOrStatusCode || error?.statusCode || 400;
    code = error?.code || (typeof error === 'string' ? error : 'error');
    message = codeOrMessage || error?.message || 'An error occurred';
    data = undefined;
  }

  const response = {
    success: false,
    error: code,
    message,
  };

  if (data) {
    response.data = data;
  }

  return res.status(statusCode).json(response);
}
