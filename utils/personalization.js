/**
 * Replace personalization placeholders in message with contact data and discount code
 * @param {string} message - Message template with placeholders
 * @param {Object} contact - Contact object with firstName, lastName, discountCode, etc.
 * @returns {string} Message with placeholders replaced
 */
export function replacePlaceholders(message, contact) {
  if (!message || typeof message !== 'string') {
    return message || '';
  }

  // Get contact data with fallbacks
  const firstName = contact?.firstName || '';
  const lastName = contact?.lastName || '';
  const discountCode = contact?.discountCode || '';

  // Replace placeholders (case-insensitive)
  let personalizedMessage = message
    .replace(/\{\{first_name\}\}/gi, firstName)
    .replace(/\{\{last_name\}\}/gi, lastName)
    .replace(/\{\{discount_code\}\}/gi, discountCode);

  // Clean up extra spaces that might result from empty replacements
  personalizedMessage = personalizedMessage.replace(/\s+/g, ' ').trim();

  return personalizedMessage;
}
