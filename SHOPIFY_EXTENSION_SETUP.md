# Shopify Extension Setup Guide

This guide explains what needs to be configured in the Shopify extension to enable automations and ensure proper customer data sync.

## Overview

The automation system requires:

1. **Webhook Registration** - Shopify must send events to our backend
2. **Customer Data Sync** - Customer information must be available in our database
3. **SMS Consent Management** - Customers must opt-in to receive SMS

---

## 1. Webhook Registration

### Automatic Registration (Recommended)

Webhooks are **automatically registered** during the OAuth installation flow. The backend registers:

- `orders/create` → Order placed automation
- `orders/fulfilled` → Order fulfilled automation
- `customers/create` → Welcome automation (future)

**No action required** - happens automatically when store installs the app.

### Manual Registration (If Needed)

If automatic registration fails or you need to re-register:

1. Go to **Shopify Admin** → **Settings** → **Notifications** → **Webhooks**
2. Click **Create webhook**
3. For each event, create a webhook:

**Order Created:**

- Event: `Order creation`
- Format: `JSON`
- URL: `https://your-backend-url.com/automation-webhooks/shopify/orders/create`
- API version: `2024-04`

**Order Fulfilled:**

- Event: `Order fulfillment`
- Format: `JSON`
- URL: `https://your-backend-url.com/automation-webhooks/shopify/orders/fulfilled`
- API version: `2024-04`

**Customer Created (for welcome automation):**

- Event: `Customer creation`
- Format: `JSON`
- URL: `https://your-backend-url.com/automation-webhooks/shopify/customers/create`
- API version: `2024-04`

---

## 2. Customer Data Sync

### Automatic Sync (Current Implementation)

**How it works:**

- When a webhook is received (order placed, order fulfilled), the backend automatically creates a contact if it doesn't exist
- Contact is created from Shopify customer data (email, name, phone)
- Default `smsConsent` is set to `'unknown'` - customers must opt-in

**What's synced:**

- Email address
- First name
- Last name
- Phone number (if available)
- Shop ID (for multi-tenant isolation)

**What's NOT synced automatically:**

- Birth date (must be added manually or via import)
- Gender (must be added manually)
- Tags (must be added manually)
- SMS consent (defaults to 'unknown', must be set to 'opted_in' for automations to work)

### Manual Sync (Future Enhancement)

A periodic sync job can be added to sync all customers from Shopify:

- Daily job to fetch all customers via Shopify Admin API
- Create/update contacts in database
- Preserve existing SMS consent status

---

## 3. SMS Consent Management

### Current Flow

1. **Contact Created** - When webhook is received, contact is created with `smsConsent: 'unknown'`
2. **User Must Opt-In** - Contact must be updated to `smsConsent: 'opted_in'` for automations to work
3. **Automation Checks Consent** - Before sending SMS, system checks if `smsConsent === 'opted_in'`

### Recommended Extension Implementation

**Option A: Checkout Consent Checkbox**

- Add SMS consent checkbox to Shopify checkout
- Store consent in customer metafield or order note
- Sync consent to backend when order is placed

**Option B: Customer Account Page**

- Add SMS consent toggle in customer account area
- Update via Shopify Admin API or customer-facing API

**Option C: Post-Purchase Page**

- Add SMS consent option after order completion
- Send consent to backend via API

### Backend API for Consent Update

**Endpoint:** `PUT /contacts/:id`

**Request Body:**

```json
{
  "smsConsent": "opted_in"
}
```

**Or via webhook:**

- When order is placed, check for consent in order/customer data
- Update contact `smsConsent` accordingly

---

## 4. Extension Configuration Checklist

### Required Configuration

- [ ] **OAuth Scopes** - Ensure these scopes are requested:
  - `read_orders` - For order webhooks
  - `read_customers` - For customer data
  - `read_products` - For product information
  - `write_discounts` - For discount code generation

- [ ] **Webhook URLs** - Verify webhook URLs are correct:
  - Backend URL must be publicly accessible
  - HTTPS required (Shopify requirement)
  - Webhook endpoints must match exactly

- [ ] **Environment Variables** - Set in backend:
  - `SHOPIFY_WEBHOOK_SECRET` or `SHOPIFY_API_SECRET` - For webhook signature verification
  - `HOST` - Backend URL for webhook registration

### Optional Configuration

- [ ] **Customer Sync** - Implement periodic customer sync
- [ ] **Consent Management** - Add SMS consent collection in checkout/account
- [ ] **Abandoned Cart Detection** - Implement Shopify Flow or Script Tags

---

## 5. Testing Automations

### Test Order Placed Automation

1. **Create Automation:**
   - Go to Automations page
   - Click "Create Automation"
   - Select trigger: "Order Placed"
   - Enter message: "Hi {{first_name}}, thanks for your order #{{orderNumber}}!"
   - Set status: "Active"
   - Save

2. **Ensure Contact Exists:**
   - Contact must exist with matching email
   - Contact must have `smsConsent: 'opted_in'`
   - Contact must have valid `phoneE164`

3. **Place Test Order:**
   - Go to Shopify Admin
   - Create a test order with customer email
   - Complete the order

4. **Verify:**
   - Check backend logs for webhook receipt
   - Check queue for automation job
   - Check MessageLog table for SMS record
   - Verify SMS was sent (check phone or Mitto dashboard)

### Test Order Fulfilled Automation

1. **Create Automation:**
   - Trigger: "Order Fulfilled"
   - Message: "Hi {{first_name}}, your order #{{orderNumber}} has shipped! Track: {{trackingLink}}"
   - Status: "Active"

2. **Fulfill Order:**
   - Go to Shopify Admin
   - Open the test order
   - Click "Fulfill items"
   - Add tracking number (optional)
   - Mark as fulfilled

3. **Verify:**
   - Check logs for webhook
   - Verify SMS sent with tracking info

### Test Birthday Automation

1. **Create Automation:**
   - Trigger: "Birthday"
   - Message: "Happy Birthday {{first_name}}! Use code BIRTHDAY20 for 20% off!"
   - Status: "Active"

2. **Create Contact:**
   - Add contact with `birthDate` set to today
   - Set `smsConsent: 'opted_in'`
   - Ensure valid `phoneE164`

3. **Wait for Cron Job:**
   - Cron runs daily at midnight UTC
   - Or trigger manually via API

4. **Verify:**
   - Check logs for birthday automation
   - Verify SMS sent

---

## 6. Troubleshooting

### Webhooks Not Received

**Check:**

1. Webhook is registered in Shopify Admin
2. Webhook URL is correct and accessible
3. Backend is running and receiving requests
4. Webhook signature verification is passing

**Debug:**

- Check Shopify webhook delivery logs (Shopify Admin → Settings → Notifications → Webhooks)
- Check backend logs for webhook receipt
- Test webhook URL manually with curl/Postman

### Automation Not Triggering

**Check:**

1. Automation exists and is `active`
2. Contact exists with matching email
3. Contact has `smsConsent: 'opted_in'`
4. Contact has valid `phoneE164`
5. Shop has sufficient credits

**Debug:**

- Check automation logs in database
- Check queue for failed jobs
- Use manual trigger endpoint to test

### SMS Not Sent

**Check:**

1. Mitto API credentials are configured
2. Shop has sufficient credits
3. Phone number is valid E.164 format
4. Message content is valid

**Debug:**

- Check MessageLog table
- Check Mitto API logs
- Verify credits balance

---

## 7. Architecture Diagram

```
┌─────────────────┐
│  Shopify Store  │
└────────┬────────┘
         │
         │ Event (Order Placed)
         ▼
┌─────────────────────────────────┐
│  Shopify Webhook                │
│  POST /automation-webhooks/...  │
└────────┬────────────────────────┘
         │
         │ 1. Verify HMAC Signature
         │ 2. Find/Create Contact
         │ 3. Queue Automation Job
         ▼
┌─────────────────────────────────┐
│  BullMQ Queue                   │
│  automation-trigger queue       │
└────────┬────────────────────────┘
         │
         │ Automation Worker Processes
         ▼
┌─────────────────────────────────┐
│  Automation Service             │
│  - Find active automation       │
│  - Check SMS consent            │
│  - Process message template     │
│  - Validate credits             │
└────────┬────────────────────────┘
         │
         │ Send SMS
         ▼
┌─────────────────────────────────┐
│  Mitto API                      │
│  SMS Delivery                   │
└─────────────────────────────────┘
```

---

## 8. Next Steps

### Immediate Actions

1. **Verify Webhook Registration**
   - Check that webhooks are registered after OAuth
   - Verify webhook URLs are correct

2. **Test End-to-End**
   - Create test automation
   - Place test order
   - Verify SMS is sent

3. **Monitor Logs**
   - Watch for webhook receipt
   - Check queue processing
   - Verify SMS delivery

### Future Enhancements

1. **Customer Sync Job**
   - Periodic sync of all customers
   - Update existing contacts
   - Handle consent status

2. **Consent Management UI**
   - Add consent checkbox in checkout
   - Customer account consent toggle
   - Consent sync from Shopify

3. **Abandoned Cart Integration**
   - Implement Shopify Flow
   - Or use Script Tags
   - Or polling for abandoned checkouts

4. **Welcome Automation**
   - Add `customers/create` webhook handler
   - Implement welcome message logic
