import { logger } from '../utils/logger.js';
import { sendSuccess } from '../utils/response.js';
import { ValidationError } from '../utils/errors.js';
import { z } from 'zod';

/**
 * Contact Form Validation Schema
 */
const contactFormSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100, 'Name is too long'),
  email: z
    .string()
    .email('Invalid email address')
    .max(255, 'Email is too long'),
  message: z
    .string()
    .min(10, 'Message must be at least 10 characters')
    .max(2000, 'Message is too long'),
});

/**
 * Submit contact form (public endpoint)
 * @route POST /public/contact
 */
export async function submitContactForm(req, res, next) {
  try {
    const { name, email, message } = req.body;

    // Validate input
    const validationResult = contactFormSchema.safeParse({
      name,
      email,
      message,
    });

    if (!validationResult.success) {
      const firstError = validationResult.error.errors[0];
      throw new ValidationError(firstError.message);
    }

    const validatedData = validationResult.data;

    // Log the contact form submission
    logger.info('Contact form submission', {
      name: validatedData.name,
      email: validatedData.email,
      messageLength: validatedData.message.length,
      timestamp: new Date().toISOString(),
    });

    // Note: Contact form submissions are logged for tracking
    // Future enhancements (if needed):
    // 1. Send email notification to support team
    // 2. Store in dedicated support tickets table
    // 3. Send auto-reply to user
    // 4. Integrate with support ticket system (e.g., Zendesk, Intercom)
    // For now, logging is sufficient for basic tracking
    // In production, implement email sending here:
    // await sendContactEmail(validatedData);
    // await storeContactSubmission(validatedData);

    return sendSuccess(
      res,
      {
        message:
          "Thank you for contacting us! We'll get back to you within 24 hours.",
        submitted: true,
      },
      'Contact form submitted successfully',
    );
  } catch (error) {
    logger.error('Contact form submission error', {
      error: error.message,
      body: req.body,
    });
    next(error);
  }
}

export default {
  submitContactForm,
};
