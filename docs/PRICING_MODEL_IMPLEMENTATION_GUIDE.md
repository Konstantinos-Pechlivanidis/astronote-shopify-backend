# Shopify Backend Pricing Model Implementation Guide

## Technical, Flow, and Action-Based Documentation

**Version:** 1.0  
**Last Updated:** 2025-01-XX  
**Purpose:** Complete technical documentation for the subscription + credit-based pricing model in shopify-backend, with migration guide from retail-backend payment solution.

---

## Table of Contents

1. [Current State Analysis](#current-state-analysis)
2. [Architecture Overview](#architecture-overview)
3. [Database Schema](#database-schema)
4. [Core Services](#core-services)
5. [API Endpoints](#api-endpoints)
6. [Stripe Integration](#stripe-integration)
7. [Webhook Handlers](#webhook-handlers)
8. [Credit System](#credit-system)
9. [Subscription Management](#subscription-management)
10. [Implementation Flow](#implementation-flow)
11. [Migration from Retail-Backend](#migration-from-retail-backend)
12. [Frontend Integration](#frontend-integration)
13. [Testing & Verification](#testing--verification)

---

## Current State Analysis

### What Shopify Backend Already Has ✅

1. **Subscription Service** (`services/subscription.js`)
   - ✅ Plan configuration (Starter, Pro)
   - ✅ Credit allocation logic
   - ✅ Subscription activation/deactivation
   - ✅ Billing period detection
   - ✅ Idempotency checks

2. **Wallet Service** (`services/wallet.js`)
   - ✅ Atomic credit/debit operations
   - ✅ CreditTransaction creation
   - ✅ Balance management
   - ✅ Transaction history

3. **Billing Service** (`services/billing.js`)
   - ✅ Credit packages (hardcoded in service)
   - ✅ Balance retrieval
   - ✅ Package purchase flow
   - ✅ Transaction history
   - ⚠️ Uses `Shop.credits` field directly (not Wallet model consistently)

4. **Stripe Service** (`services/stripe.js`)
   - ✅ Checkout session creation
   - ✅ Webhook signature verification
   - ⚠️ Missing subscription checkout session creation
   - ⚠️ Missing credit top-up checkout session creation

5. **Webhook Handlers** (`controllers/stripe-webhooks.js`)
   - ✅ Basic webhook routing
   - ✅ Subscription checkout handling
   - ✅ Credit top-up handling
   - ⚠️ Missing some webhook handlers (refunds, subscription updates)

6. **API Routes**
   - ✅ Subscription routes (`routes/subscriptions.js`)
   - ✅ Billing routes (`routes/billing.js`)
   - ✅ Webhook route (`routes/stripe-webhooks.js`)

### What's Missing or Needs Improvement ❌

1. **Database Models**
   - ❌ `Package` model (currently hardcoded in service)
   - ❌ `Purchase` model (uses `BillingTransaction` instead)
   - ⚠️ `SmsPackage` exists but not used consistently

2. **Credit Top-up**
   - ⚠️ Partially implemented
   - ❌ Missing complete flow matching retail-backend

3. **Webhook Handlers**
   - ❌ Missing `charge.refunded` handler (partial implementation)
   - ❌ Missing `customer.subscription.updated` handler (partial implementation)
   - ⚠️ Some handlers need refinement

4. **Stripe Service**
   - ❌ Missing `createSubscriptionCheckoutSession()`
   - ❌ Missing `createCreditTopupCheckoutSession()`
   - ❌ Missing `updateSubscription()`
   - ❌ Missing `cancelSubscription()`
   - ❌ Missing `getCustomerPortalUrl()`

5. **API Endpoints**
   - ⚠️ Missing `/api/subscriptions/portal` endpoint
   - ⚠️ Some endpoints need refinement

---

## Architecture Overview

### Pricing Model Components

The pricing system consists of three main components:

1. **Subscriptions** - Recurring billing with included free credits
2. **Credit Top-ups** - Pay-as-you-go credit purchases
3. **Credit Packages** - Predefined credit bundles (subscription required)

### System Flow

```
Shop Action → Frontend → Backend API → Stripe Checkout
                                          ↓
                                    Shop Payment
                                          ↓
                                    Stripe Webhooks
                                          ↓
                                    Backend Processing
                                          ↓
                                    Credit Allocation
                                          ↓
                                    Database Update
```

### Key Differences from Retail-Backend

1. **Entity Model:** Uses `Shop` instead of `User`
2. **ID Type:** Uses `String` (CUID) instead of `Int`
3. **Credit Storage:** Dual system - `Shop.credits` field AND `Wallet` model
4. **Package Storage:** Hardcoded in service, not in database

### Key Principles

1. **Idempotency:** All operations are idempotent to handle webhook retries
2. **Atomicity:** Wallet operations use database transactions
3. **Credit Enforcement:** Credits are checked before SMS sending
4. **No Expiration:** Credits never expire
5. **Subscription Gating:** Credit packages require active subscription

---

## Database Schema

### Current Models

#### Shop Model

```prisma
model Shop {
  id                        String               @id @default(cuid())
  shopDomain                String               @unique
  credits                   Int                  @default(0)  // Direct credit field
  // Subscription fields
  stripeCustomerId          String?              @db.VarChar(255)
  stripeSubscriptionId      String?              @db.VarChar(255)
  planType                  SubscriptionPlanType?  // 'starter' | 'pro'
  subscriptionStatus        SubscriptionStatus    @default(inactive)
  lastFreeCreditsAllocatedAt DateTime?

  // Relations
  wallet                    Wallet?
  creditTransactions        CreditTransaction[]
  billingTransactions       BillingTransaction[]
}
```

#### Wallet Model

```prisma
model Wallet {
  id          String   @id @default(cuid())
  shopId      String   @unique
  balance     Int      @default(0)  // credits balance
  totalUsed   Int      @default(0)
  totalBought Int      @default(0)
  active      Boolean  @default(true)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  shop        Shop     @relation(fields: [shopId], references: [id], onDelete: Cascade)
  creditTransactions CreditTransaction[]
}
```

**Note:** There's a dual credit system - `Shop.credits` and `Wallet.balance`. The system should use `Wallet.balance` consistently.

#### CreditTransaction Model

```prisma
model CreditTransaction {
  id           String          @id @default(cuid())
  shopId       String
  shop         Shop            @relation(fields: [shopId], references: [id], onDelete: Cascade)
  type         CreditTxnType   // 'credit' | 'debit' | 'refund'
  amount       Int              // positive integer (credits)
  balanceAfter Int              // snapshot of wallet balance after this txn
  reason       String?          @db.VarChar(200)
  campaignId   String?
  campaign     Campaign?        @relation(fields: [campaignId], references: [id], onDelete: SetNull)
  messageId    String?
  message      MessageLog?     @relation(fields: [messageId], references: [id], onDelete: SetNull)
  meta         Json?
  createdAt    DateTime         @default(now())
  walletId    String?
  wallet       Wallet?          @relation(fields: [walletId], references: [id], onDelete: SetNull)

  @@index([shopId])
  @@index([campaignId])
  @@index([messageId])
  @@index([walletId])
  @@index([createdAt])
  @@index([reason])
  @@index([shopId, reason])  // For idempotency checks
}
```

#### BillingTransaction Model (Current)

```prisma
model BillingTransaction {
  id              String   @id @default(cuid())
  shopId          String
  creditsAdded    Int
  amount          Int      // Amount in cents
  currency        String   @default("EUR")
  packageType     String   // Package ID (hardcoded)
  stripeSessionId String
  stripePaymentId String?
  status          String   @default("pending")  // pending, completed, failed
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  shop            Shop     @relation(fields: [shopId], references: [id], onDelete: Cascade)

  @@index([shopId, createdAt])
}
```

**Note:** This is used instead of `Purchase` model. Should be migrated to `Purchase` model for consistency with retail-backend.

#### SmsPackage Model (Unused)

```prisma
model SmsPackage {
  id          String   @id @default(cuid())
  name        String
  credits     Int
  priceCents  Int
  currency    String   @default("EUR")
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  description String?
  features    String[] @default([])
  isActive    Boolean  @default(true)
  isPopular   Boolean  @default(false)
}
```

**Note:** This model exists but is not used. Should be replaced with `Package` model.

### Enums

```prisma
enum SubscriptionPlanType {
  starter
  pro
}

enum SubscriptionStatus {
  active
  inactive
  cancelled
}

enum CreditTxnType {
  credit  // e.g. admin topup, purchase, subscription credits
  debit   // e.g. campaign enqueue
  refund  // e.g. immediate provider hard-fail, stripe refund
}
```

### Recommended Schema Updates

#### Add Package Model

```prisma
model Package {
  id         String   @id @default(cuid())
  name       String   @unique
  units      Int      // credits included
  priceCents Int      // price in cents (for reference)
  active     Boolean  @default(true)
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt
  Purchase   Purchase[]

  // Stripe price IDs (optional, can be set via env or admin)
  stripePriceIdEur String? @db.VarChar(255)
  stripePriceIdUsd String? @db.VarChar(255)

  @@index([stripePriceIdEur])
  @@index([stripePriceIdUsd])
}
```

#### Add Purchase Model

```prisma
model Purchase {
  id         String        @id @default(cuid())
  shopId     String
  packageId  String
  package    Package       @relation(fields: [packageId], references: [id], onDelete: Restrict)
  units      Int
  priceCents Int
  status     PaymentStatus @default(pending)
  createdAt  DateTime      @default(now())
  updatedAt  DateTime      @updatedAt

  // Stripe integration
  stripeSessionId       String? @unique
  stripePaymentIntentId String?
  stripeCustomerId      String?
  stripePriceId         String?
  currency              String? @db.VarChar(3)

  shop Shop @relation(fields: [shopId], references: [id], onDelete: Cascade)

  @@index([shopId])
  @@index([packageId])
  @@index([stripeSessionId])
  @@index([status])
  @@index([shopId, status])
}

enum PaymentStatus {
  pending
  paid
  failed
  refunded
}
```

#### Update Shop Model

```prisma
model Shop {
  // ... existing fields
  Purchase Purchase[]
}
```

---

## Core Services

### 1. Subscription Service

**Location:** `services/subscription.js`

**Status:** ✅ Complete (matches retail-backend)

**Key Functions:**

```javascript
// Plan configuration
export const PLANS = {
  starter: {
    priceEur: 40, // €40/month
    freeCredits: 100, // 100 credits/month
    stripePriceIdEnv: 'STRIPE_PRICE_ID_SUB_STARTER_EUR',
  },
  pro: {
    priceEur: 240, // €240/year
    freeCredits: 500, // 500 credits/year
    stripePriceIdEnv: 'STRIPE_PRICE_ID_SUB_PRO_EUR',
  },
};

// Credit pricing
export const CREDIT_PRICE_EUR = 0.045; // Base price per credit
export const VAT_RATE = 0.24; // 24% VAT

// Core functions
-getFreeCreditsForPlan(planType) -
  getPlanConfig(planType) -
  isSubscriptionActive(shopId) -
  getSubscriptionStatus(shopId) -
  allocateFreeCredits(shopId, planType, invoiceId, stripeSubscription) -
  activateSubscription(
    shopId,
    stripeCustomerId,
    stripeSubscriptionId,
    planType
  ) -
  deactivateSubscription(shopId, reason) -
  calculateTopupPrice(credits) -
  getBillingPeriodStart(stripeSubscription, now);
```

**Key Implementation Details:**

1. **Credit Allocation Idempotency:**
   - Checks `CreditTransaction` with `reason: 'subscription:{planType}:cycle'` and `meta.invoiceId`
   - Prevents duplicate allocations on webhook retries

2. **Billing Period Detection:**
   - Uses `stripeSubscription.current_period_start` if available
   - Falls back to `lastFreeCreditsAllocatedAt` for monthly billing
   - Prevents multiple allocations in the same billing period

3. **Subscription Activation:**
   - Validates plan type ('starter' or 'pro')
   - Updates all subscription fields atomically
   - Keeps historical data (planType, stripeCustomerId) on cancellation

### 2. Wallet Service

**Location:** `services/wallet.js`

**Status:** ✅ Complete (matches retail-backend)

**Key Functions:**

```javascript
-ensureWallet(shopId) - // Creates wallet if doesn't exist
  getBalance(shopId) - // Returns current balance
  credit(shopId, amount, opts, tx) - // Add credits
  debit(shopId, amount, opts, tx) - // Consume credits (throws on insufficient)
  refund(shopId, amount, opts, tx) - // Return credits
  createCreditTransaction(shopId, type, amount, reason, meta, tx);
```

**Key Implementation Details:**

1. **Atomic Operations:**
   - All operations use `prisma.$transaction()` or accept `tx` parameter
   - Wallet balance and transaction records updated together
   - Prevents race conditions

2. **Insufficient Credits:**
   - `debit()` throws `ValidationError` if balance would go negative
   - Error is caught by calling code (campaigns, SMS service)

3. **Transaction Records:**
   - Every operation creates a `CreditTransaction` record
   - Includes `balanceAfter` snapshot for audit trail
   - `reason` field describes the transaction purpose

**Note:** The service uses `Wallet.balance` correctly, but `billingService` uses `Shop.credits` directly. This inconsistency should be resolved.

### 3. Billing Service

**Location:** `services/billing.js`

**Status:** ⚠️ Needs Updates

**Current Implementation:**

- Uses hardcoded `CREDIT_PACKAGES` array
- Uses `Shop.credits` field directly (not `Wallet.balance`)
- Uses `BillingTransaction` instead of `Purchase` model

**Key Functions:**

```javascript
-getBalance(storeId) - // Returns Shop.credits (should use Wallet.balance)
  getPackages(currency) - // Returns hardcoded packages
  getPackageById(packageId) - // Returns from hardcoded array
  createPurchaseSession(storeId, packageId, returnUrls, requestedCurrency) -
  handleStripeWebhook(stripeEvent) - // Handles package purchases
  addCredits(storeId, credits, ref, meta) - // Updates Shop.credits directly
  deductCredits(storeId, credits, ref, meta) - // Updates Shop.credits directly
  processRefund(storeId, transactionId, creditsToRefund, refundId, meta) -
  getTransactionHistory(storeId, filters) -
  getBillingHistory(storeId, filters);
```

**Issues:**

1. **Dual Credit System:** Uses `Shop.credits` instead of `Wallet.balance`
2. **Hardcoded Packages:** Should use `Package` model from database
3. **No Purchase Model:** Uses `BillingTransaction` instead

### 4. Stripe Service

**Location:** `services/stripe.js`

**Status:** ⚠️ Incomplete

**Current Functions:**

```javascript
-createStripeCheckoutSession() - // For packages only
  getCheckoutSession(sessionId) -
  verifyWebhookSignature(payload, signature);
```

**Missing Functions (from retail-backend):**

```javascript
-createSubscriptionCheckoutSession() - // ❌ Missing
  createCreditTopupCheckoutSession() - // ❌ Missing
  updateSubscription() - // ❌ Missing
  cancelSubscription() - // ❌ Missing
  getCustomerPortalUrl() - // ❌ Missing
  getStripePriceId() - // ❌ Missing
  getStripeSubscriptionPriceId() - // ❌ Missing
  getStripeCreditTopupPriceId(); // ❌ Missing
```

---

## API Endpoints

### Subscription Endpoints

#### GET `/api/subscriptions/status`

Get current subscription status.

**Response:**

```json
{
  "success": true,
  "data": {
    "active": true,
    "planType": "starter",
    "status": "active",
    "stripeCustomerId": "cus_xxx",
    "stripeSubscriptionId": "sub_xxx",
    "lastFreeCreditsAllocatedAt": "2025-01-01T00:00:00Z"
  }
}
```

#### POST `/api/subscriptions/subscribe`

Create subscription checkout session.

**Request:**

```json
{
  "planType": "starter" | "pro"
}
```

**Response:**

```json
{
  "success": true,
  "data": {
    "checkoutUrl": "https://checkout.stripe.com/...",
    "sessionId": "cs_xxx",
    "planType": "starter"
  }
}
```

**Validation:**

- Plan type must be 'starter' or 'pro'
- Shop must not have active subscription
- Returns error if already subscribed

#### POST `/api/subscriptions/update`

Update subscription plan (upgrade/downgrade).

**Request:**

```json
{
  "planType": "starter" | "pro"
}
```

**Response:**

```json
{
  "success": true,
  "data": {
    "planType": "starter"
  },
  "message": "Subscription updated to starter plan successfully"
}
```

#### POST `/api/subscriptions/cancel`

Cancel subscription.

**Response:**

```json
{
  "success": true,
  "data": {
    "cancelledAt": "2025-01-01T00:00:00Z"
  },
  "message": "Subscription cancelled successfully"
}
```

#### POST `/api/subscriptions/verify-session`

Manually verify and activate subscription.

**Request:**

```json
{
  "sessionId": "cs_xxx"
}
```

**Response:**

```json
{
  "success": true,
  "data": {
    "subscription": { ... },
    "creditsAllocated": 100
  },
  "message": "Subscription verified and activated"
}
```

#### GET `/api/subscriptions/portal` ❌ Missing

Get Stripe Customer Portal URL.

**Should Return:**

```json
{
  "success": true,
  "data": {
    "portalUrl": "https://billing.stripe.com/..."
  }
}
```

### Billing Endpoints

#### GET `/api/billing/balance`

Get wallet balance and subscription status.

**Response:**

```json
{
  "success": true,
  "data": {
    "credits": 500,
    "balance": 500,
    "currency": "EUR"
  }
}
```

**Note:** Currently returns `Shop.credits`. Should return `Wallet.balance`.

#### GET `/api/billing/packages`

List active credit packages (subscription required).

**Response:**

```json
{
  "success": true,
  "data": {
    "packages": [
      {
        "id": "package_1000",
        "name": "1,000 SMS Credits",
        "credits": 1000,
        "price": 29.99,
        "currency": "EUR"
      }
    ],
    "currency": "EUR",
    "subscriptionRequired": false
  }
}
```

**Access Control:**

- Returns empty array if subscription is not active
- Currently uses hardcoded packages

#### POST `/api/billing/purchase`

Create checkout session for credit package.

**Request:**

```json
{
  "packageId": "package_1000",
  "currency": "EUR"
}
```

**Response:**

```json
{
  "success": true,
  "data": {
    "sessionId": "cs_xxx",
    "sessionUrl": "https://checkout.stripe.com/...",
    "transactionId": "bt_xxx",
    "package": { ... }
  }
}
```

**Validation:**

- Package must exist (from hardcoded array)
- Shop must have active subscription
- Creates `BillingTransaction` record with status 'pending'

#### GET `/api/billing/topup/calculate`

Calculate price for given number of credits.

**Query Parameters:**

- `credits` (required)

**Response:**

```json
{
  "success": true,
  "data": {
    "credits": 1000,
    "priceEur": 45.0,
    "vatAmount": 10.8,
    "priceEurWithVat": 55.8
  }
}
```

#### POST `/api/billing/topup`

Create checkout session for credit top-up.

**Request:**

```json
{
  "credits": 1000
}
```

**Response:**

```json
{
  "success": true,
  "data": {
    "checkoutUrl": "https://checkout.stripe.com/...",
    "sessionId": "cs_xxx",
    "credits": 1000,
    "priceEur": 55.8,
    "priceBreakdown": {
      "credits": 1000,
      "priceEur": 45.0,
      "vatAmount": 10.8,
      "priceEurWithVat": 55.8
    }
  }
}
```

**Validation:**

- Credits must be positive integer
- Maximum: 1,000,000 credits per purchase
- Available to all shops (subscription not required)

#### GET `/api/billing/history`

Get transaction history.

**Query Parameters:**

- `page` (default: 1)
- `pageSize` (default: 20)
- `type` (optional: 'purchase', 'debit', 'credit', 'refund', 'adjustment')
- `startDate` (optional)
- `endDate` (optional)

**Response:**

```json
{
  "success": true,
  "data": {
    "transactions": [...],
    "pagination": {
      "page": 1,
      "pageSize": 20,
      "total": 50,
      "totalPages": 3,
      "hasNextPage": true,
      "hasPrevPage": false
    }
  }
}
```

#### GET `/api/billing/billing-history`

Get billing history (Stripe transactions).

**Query Parameters:**

- `page` (default: 1)
- `pageSize` (default: 20)
- `status` (optional: 'pending', 'completed', 'failed')

**Response:**

```json
{
  "success": true,
  "data": {
    "transactions": [...],
    "pagination": { ... }
  }
}
```

---

## Stripe Integration

### Environment Variables

```bash
# Required
STRIPE_SECRET_KEY=sk_xxx
STRIPE_WEBHOOK_SECRET=whsec_xxx

# Subscription Price IDs
STRIPE_PRICE_ID_SUB_STARTER_EUR=price_xxx
STRIPE_PRICE_ID_SUB_PRO_EUR=price_xxx

# Credit Top-up Price ID (optional)
STRIPE_PRICE_ID_CREDIT_TOPUP_EUR=price_xxx

# Package Price IDs (currently hardcoded in service)
STRIPE_PRICE_ID_1000_EUR=price_xxx
STRIPE_PRICE_ID_5000_EUR=price_xxx
STRIPE_PRICE_ID_10000_EUR=price_xxx
STRIPE_PRICE_ID_25000_EUR=price_xxx
```

### Stripe Configuration

1. **Subscription Prices:**
   - Starter: Recurring monthly price (€40/month)
   - Pro: Recurring yearly price (€240/year)

2. **Credit Top-up:**
   - One-time payment
   - Price calculated dynamically (credits × €0.045 + 24% VAT)

3. **Credit Packages:**
   - One-time payment
   - Currently hardcoded in service (should be in database)

### Webhook Endpoint

**URL:** `POST /api/stripe/webhooks`

**Required Events:**

- `checkout.session.completed`
- `invoice.payment_succeeded`
- `invoice.payment_failed`
- `charge.refunded` / `payment_intent.refunded`
- `customer.subscription.deleted`
- `customer.subscription.updated`

---

## Webhook Handlers

### Current Implementation

**Location:** `controllers/stripe-webhooks.js`

#### 1. checkout.session.completed ✅

**Handler:** `handleCheckoutSessionCompleted()`

**Process:**

1. Routes based on `metadata.type`:
   - `'subscription'` → `handleCheckoutSessionCompletedForSubscription()`
   - `'credit_topup'` → `handleCheckoutSessionCompletedForTopup()`
   - Legacy: Package purchase → `billingService.handleStripeWebhook()`

**Subscription Flow:**

1. Extract: `shopId`, `planType`
2. Get subscription ID from session
3. Retrieve subscription from Stripe
4. Activate subscription in database
5. Allocate free credits (invoice ID: `sub_{subscriptionId}`)

**Top-up Flow:**

1. Extract: `shopId`, `credits`, `priceEur`
2. Validate payment amount
3. Check idempotency (session ID)
4. Credit wallet atomically

**Package Flow:**

1. Extract: `shopId`, `transactionId`, `credits`
2. Find `BillingTransaction` record
3. Verify status is 'pending'
4. Update `Shop.credits` directly (should use Wallet)
5. Update `BillingTransaction.status = 'completed'`

#### 2. invoice.payment_succeeded ✅

**Handler:** `handleInvoicePaymentSucceeded()`

**Filtering:**

- Skip `billing_reason = 'subscription_create'` (handled by checkout.session.completed)
- Process only `billing_reason = 'subscription_cycle'` (recurring billing)

**Process:**

1. Extract: `subscriptionId`, `customerId`, `invoiceId`
2. Find shop by `stripeCustomerId`
3. Verify `stripeSubscriptionId` matches
4. Verify `subscriptionStatus = 'active'`
5. Retrieve subscription from Stripe
6. Allocate free credits (idempotent, invoice ID: `invoice.id`)

#### 3. invoice.payment_failed ✅

**Handler:** `handleInvoicePaymentFailed()`

**Filtering:**

- Process only `billing_reason = 'subscription_cycle'` or `'subscription_update'`

**Process:**

1. Find shop by `stripeCustomerId`
2. Verify `stripeSubscriptionId` matches
3. Retrieve subscription from Stripe
4. Update subscription status:
   - `past_due` or `unpaid` → `'inactive'`
   - `cancelled` → `'cancelled'`

#### 4. charge.refunded / payment_intent.refunded ⚠️

**Handler:** `handleRefund()`

**Status:** Partially implemented

**Current Process:**

1. Routes to `billingService.handleStripeWebhook()`
2. Finds `BillingTransaction` by `stripePaymentId`
3. Calculates credits to refund (proportional if partial)
4. Deducts credits from `Shop.credits` (should use Wallet)
5. Creates `WalletTransaction` record

**Issues:**

- Uses `Shop.credits` instead of `Wallet.balance`
- Should create `CreditTransaction` with type 'refund'
- Should update `Purchase.status = 'refunded'` (when Purchase model is added)

#### 5. customer.subscription.deleted ✅

**Handler:** `handleSubscriptionDeleted()`

**Process:**

1. Find shop by `stripeSubscriptionId`
2. Deactivate subscription: `subscriptionStatus = 'cancelled'`

#### 6. customer.subscription.updated ⚠️

**Handler:** `handleSubscriptionUpdated()`

**Status:** Partially implemented

**Current Process:**

1. Find shop by `stripeSubscriptionId`
2. Extract `planType` from subscription metadata
3. Map Stripe status to local status
4. Update `subscriptionStatus` and/or `planType` if changed

**Issues:**

- Needs refinement to match retail-backend implementation
- Should handle all Stripe statuses correctly

---

## Credit System

### Credit Pricing

- **Base Price:** €0.045 per credit
- **VAT Rate:** 24% (Greece)
- **Final Price:** €0.0558 per credit (€0.045 × 1.24)

### Credit Consumption

- **Rule:** Each SMS message consumes exactly 1 credit
- **Enforcement:** Credits checked before SMS sending
- **Insufficient Credits:** Operation fails, returns error

### Credit Sources

1. **Subscription Free Credits:**
   - Starter: 100 credits/month
   - Pro: 500 credits/year
   - Allocated on billing cycle renewal

2. **Credit Top-ups:**
   - Custom amount (shop specifies)
   - Available to all shops
   - One-time payment

3. **Credit Packages:**
   - Predefined amounts (currently hardcoded)
   - Requires active subscription
   - One-time payment

4. **Refunds:**
   - Credits deducted on refund
   - Creates refund transaction

### Credit Expiration

**Rule:** Credits never expire.

**Implementation:**

- No expiration logic in codebase
- Credits remain in wallet indefinitely

### Credit Storage Issue

**Current Problem:**

- `billingService` uses `Shop.credits` field directly
- `walletService` uses `Wallet.balance` field
- This creates inconsistency

**Solution:**

- Migrate all credit operations to use `Wallet.balance` only
- Remove direct updates to `Shop.credits`
- Use `walletService` for all credit operations

---

## Subscription Management

### Subscription Lifecycle

1. **Install:** Shop installs app (no subscription)
2. **Subscribe:** Shop selects plan → Stripe Checkout → Webhook activates → Free credits allocated
3. **Renewal:** Stripe generates invoice → Webhook processes → Free credits allocated
4. **Update:** Shop changes plan → Stripe subscription updated → Local DB updated
5. **Cancel:** Shop cancels → Stripe subscription cancelled → Local DB updated to 'cancelled'

### Subscription Status

- **active:** Subscription is active, receiving free credits
- **inactive:** Subscription paused or payment failed
- **cancelled:** Subscription cancelled, no future credits

### Plan Changes

**Behavior:** Changing plans does not allocate free credits immediately.

**Reason:** Free credits are allocated only on billing cycle renewals.

**Note:** Shop must wait until next billing cycle to receive credits for new plan.

---

## Implementation Flow

### Complete Shop Journey

#### 1. Shop Installs App

```
Shop Installation → Account Created → Wallet Created (balance = 0)
```

#### 2. Shop Subscribes

```
POST /api/subscriptions/subscribe
  → Create Stripe Checkout Session
  → Redirect to Stripe
  → Shop Completes Payment
  → Webhook: checkout.session.completed
    → Activate Subscription
    → Allocate Free Credits (100 or 500)
  → Shop Redirected to Success Page
```

#### 3. Subscription Renewal

```
Stripe Generates Invoice
  → Webhook: invoice.payment_succeeded
    → Verify Subscription Active
    → Allocate Free Credits (idempotent)
  → Shop Receives Credits
```

#### 4. Shop Purchases Credits

```
Option A: Credit Top-up
  POST /api/billing/topup
    → Calculate Price
    → Create Stripe Checkout Session
    → Shop Completes Payment
    → Webhook: checkout.session.completed
      → Credit Wallet
    → Shop Receives Credits

Option B: Credit Package
  GET /api/billing/packages (subscription required)
  POST /api/billing/purchase
    → Create Stripe Checkout Session
    → Shop Completes Payment
    → Webhook: checkout.session.completed
      → Credit Wallet (currently Shop.credits)
      → Update BillingTransaction Status
    → Shop Receives Credits
```

#### 5. Shop Sends SMS

```
Campaign Enqueue / SMS Send
  → Check Wallet Balance
  → If Sufficient: Debit Credits → Send SMS
  → If Insufficient: Return Error → Block Send
```

#### 6. Payment Fails

```
Stripe Payment Fails
  → Webhook: invoice.payment_failed
    → Update Subscription Status to 'inactive'
  → Shop Can Update Payment Method
  → Stripe Retries Payment
```

#### 7. Shop Cancels

```
POST /api/subscriptions/cancel
  → Cancel Stripe Subscription
  → Update Local DB to 'cancelled'
  → Shop Retains Existing Credits
  → No Future Free Credits
```

---

## Migration from Retail-Backend

### Step-by-Step Migration Guide

#### Step 1: Database Schema Updates

**1.1 Add Package Model**

Create migration:

```bash
npx prisma migrate dev --name add_package_model
```

Add to `schema.prisma`:

```prisma
model Package {
  id         String   @id @default(cuid())
  name       String   @unique
  units      Int      // credits included
  priceCents Int      // price in cents
  active     Boolean  @default(true)
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt
  Purchase   Purchase[]

  stripePriceIdEur String? @db.VarChar(255)
  stripePriceIdUsd String? @db.VarChar(255)

  @@index([stripePriceIdEur])
  @@index([stripePriceIdUsd])
}
```

**1.2 Add Purchase Model**

Add to `schema.prisma`:

```prisma
model Purchase {
  id         String        @id @default(cuid())
  shopId     String
  packageId  String
  package    Package       @relation(fields: [packageId], references: [id], onDelete: Restrict)
  units      Int
  priceCents Int
  status     PaymentStatus @default(pending)
  createdAt  DateTime      @default(now())
  updatedAt  DateTime      @updatedAt

  stripeSessionId       String? @unique
  stripePaymentIntentId String?
  stripeCustomerId      String?
  stripePriceId         String?
  currency              String? @db.VarChar(3)

  shop Shop @relation(fields: [shopId], references: [id], onDelete: Cascade)

  @@index([shopId])
  @@index([packageId])
  @@index([stripeSessionId])
  @@index([status])
  @@index([shopId, status])
}

enum PaymentStatus {
  pending
  paid
  failed
  refunded
}
```

**1.3 Update Shop Model**

Add relation:

```prisma
model Shop {
  // ... existing fields
  Purchase Purchase[]
}
```

**1.4 Run Migration**

```bash
npx prisma migrate dev --name add_packages_and_purchases
```

#### Step 2: Update Stripe Service

**2.1 Add Missing Functions**

Add to `services/stripe.js`:

```javascript
/**
 * Get Stripe price ID for a package and currency
 */
export function getStripePriceId(
  packageName,
  currency = 'EUR',
  packageDb = null
) {
  const upperCurrency = currency.toUpperCase();

  // First priority: Check package DB fields if provided
  if (packageDb) {
    if (upperCurrency === 'USD' && packageDb.stripePriceIdUsd) {
      return packageDb.stripePriceIdUsd;
    }
    if (upperCurrency === 'EUR' && packageDb.stripePriceIdEur) {
      return packageDb.stripePriceIdEur;
    }
  }

  // Second priority: Environment variable
  const envKey = `STRIPE_PRICE_ID_${packageName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_${upperCurrency}`;
  const envPriceId = process.env[envKey];
  if (envPriceId) return envPriceId;

  // Fallback: Generic format
  const genericKey = `STRIPE_PRICE_ID_${upperCurrency}`;
  return process.env[genericKey] || null;
}

/**
 * Get Stripe subscription price ID for a plan
 */
export function getStripeSubscriptionPriceId(planType, currency = 'EUR') {
  const upperCurrency = currency.toUpperCase();
  const envKey = `STRIPE_PRICE_ID_SUB_${planType.toUpperCase()}_${upperCurrency}`;
  return process.env[envKey] || null;
}

/**
 * Get Stripe credit top-up price ID
 */
export function getStripeCreditTopupPriceId(currency = 'EUR') {
  const upperCurrency = currency.toUpperCase();
  const envKey = `STRIPE_PRICE_ID_CREDIT_TOPUP_${upperCurrency}`;
  return process.env[envKey] || null;
}

/**
 * Create a Stripe checkout session for subscription
 */
export async function createSubscriptionCheckoutSession({
  shopId,
  shopDomain,
  planType,
  currency = 'EUR',
  successUrl,
  cancelUrl,
}) {
  if (!stripe) {
    throw new Error('Stripe is not configured');
  }

  if (!['starter', 'pro'].includes(planType)) {
    throw new Error(`Invalid plan type: ${planType}`);
  }

  const priceId = getStripeSubscriptionPriceId(planType, currency);
  if (!priceId) {
    throw new Error(
      `Stripe price ID not found for subscription plan ${planType} (${currency})`
    );
  }

  // Verify the price exists and is a recurring price
  try {
    const price = await stripe.prices.retrieve(priceId);
    if (price.type !== 'recurring') {
      throw new Error(`Price ID ${priceId} is not a recurring price`);
    }
  } catch (err) {
    if (
      err.type === 'StripeInvalidRequestError' &&
      err.code === 'resource_missing'
    ) {
      throw new Error(`Price ID ${priceId} not found in Stripe`);
    }
    throw err;
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    payment_method_types: ['card'],
    line_items: [
      {
        price: priceId,
        quantity: 1,
      },
    ],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: {
      shopId,
      planType,
      type: 'subscription',
    },
    customer_email: `${shopDomain}@astronote.com`,
    subscription_data: {
      metadata: {
        shopId,
        planType,
      },
    },
  });

  return session;
}

/**
 * Create a Stripe checkout session for credit top-up
 */
export async function createCreditTopupCheckoutSession({
  shopId,
  shopDomain,
  credits,
  priceEur,
  currency = 'EUR',
  successUrl,
  cancelUrl,
}) {
  if (!stripe) {
    throw new Error('Stripe is not configured');
  }

  // Try to get price ID from environment
  const priceId = getStripeCreditTopupPriceId(currency);

  // If no price ID, create a one-time payment with custom amount
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    line_items: priceId
      ? [
          {
            price: priceId,
            quantity: Math.ceil(credits / 1000), // Adjust quantity based on price unit
          },
        ]
      : [
          {
            price_data: {
              currency: currency.toLowerCase(),
              product_data: {
                name: `${credits} SMS Credits`,
                description: `Credit top-up for ${credits} SMS messages`,
              },
              unit_amount: Math.round(priceEur * 100), // Convert to cents
            },
            quantity: 1,
          },
        ],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: {
      shopId,
      credits: credits.toString(),
      priceEur: priceEur.toString(),
      type: 'credit_topup',
    },
    customer_email: `${shopDomain}@astronote.com`,
  });

  return session;
}

/**
 * Update subscription plan
 */
export async function updateSubscription(subscriptionId, planType) {
  if (!stripe) {
    throw new Error('Stripe is not configured');
  }

  if (!['starter', 'pro'].includes(planType)) {
    throw new Error(`Invalid plan type: ${planType}`);
  }

  // Get current subscription
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);

  // Get new price ID
  const newPriceId = getStripeSubscriptionPriceId(planType, 'EUR');
  if (!newPriceId) {
    throw new Error(`Stripe price ID not found for plan ${planType}`);
  }

  // Update subscription
  const updated = await stripe.subscriptions.update(subscriptionId, {
    items: [
      {
        id: subscription.items.data[0].id,
        price: newPriceId,
      },
    ],
    metadata: {
      ...subscription.metadata,
      planType,
    },
  });

  return updated;
}

/**
 * Cancel subscription
 */
export async function cancelSubscription(subscriptionId) {
  if (!stripe) {
    throw new Error('Stripe is not configured');
  }

  return stripe.subscriptions.cancel(subscriptionId);
}

/**
 * Get Stripe Customer Portal URL
 */
export async function getCustomerPortalUrl({ customerId, returnUrl }) {
  if (!stripe) {
    throw new Error('Stripe is not configured');
  }

  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  });

  return session.url;
}
```

#### Step 3: Update Billing Service

**3.1 Migrate to Package Model**

Update `services/billing.js`:

```javascript
// Replace hardcoded CREDIT_PACKAGES with database queries
export async function getPackages(currency = 'EUR') {
  const packages = await prisma.package.findMany({
    where: { active: true },
    orderBy: { units: 'asc' },
  });

  return packages.map(pkg => ({
    id: pkg.id,
    name: pkg.name,
    credits: pkg.units,
    price: (pkg.priceCents / 100).toFixed(2),
    currency,
    // ... other fields
  }));
}
```

**3.2 Migrate to Purchase Model**

Update `createPurchaseSession()`:

```javascript
// Create Purchase record instead of BillingTransaction
const purchase = await prisma.purchase.create({
  data: {
    shopId: storeId,
    packageId: pkg.id,
    units: pkg.units,
    priceCents: Math.round(price * 100),
    status: 'pending',
    currency,
  },
});

// Update with session ID after creation
await prisma.purchase.update({
  where: { id: purchase.id },
  data: { stripeSessionId: session.id },
});
```

**3.3 Migrate Credit Operations to Wallet**

Update `addCredits()` and `deductCredits()`:

```javascript
// Replace Shop.credits updates with walletService
import { credit, debit } from './wallet.js';

export async function addCredits(shopId, credits, ref, meta = {}) {
  // Use walletService instead of Shop.credits
  await credit(shopId, credits, {
    reason: ref,
    meta,
  });
}

export async function deductCredits(shopId, credits, ref, meta = {}) {
  // Use walletService instead of Shop.credits
  await debit(shopId, credits, {
    reason: ref,
    meta,
  });
}
```

#### Step 4: Update Webhook Handlers

**4.1 Update Refund Handler**

Update `handleRefund()` in `controllers/stripe-webhooks.js`:

```javascript
async function handleRefund(event) {
  const refund = event.data.object;
  const paymentIntentId = refund.payment_intent || refund.id;

  // Find CreditTransaction by paymentIntentId
  const creditTxn = await prisma.creditTransaction.findFirst({
    where: {
      meta: {
        path: ['paymentIntentId'],
        equals: paymentIntentId,
      },
      type: 'credit',
    },
  });

  if (!creditTxn) {
    logger.warn('Credit transaction not found for refund', { paymentIntentId });
    return;
  }

  // Deduct credits using walletService
  const { refund: refundCredits } = require('../services/wallet.js');
  await refundCredits(creditTxn.shopId, creditTxn.amount, {
    reason: 'stripe:refund',
    meta: {
      refundId: refund.id,
      paymentIntentId,
      originalTransactionId: creditTxn.id,
    },
  });

  // Update Purchase status if exists
  const purchase = await prisma.purchase.findFirst({
    where: {
      stripePaymentIntentId: paymentIntentId,
      status: 'paid',
    },
  });

  if (purchase) {
    await prisma.purchase.update({
      where: { id: purchase.id },
      data: { status: 'refunded' },
    });
  }
}
```

**4.2 Update Subscription Updated Handler**

Ensure `handleSubscriptionUpdated()` matches retail-backend implementation:

```javascript
async function handleSubscriptionUpdated(subscription) {
  const subscriptionId = subscription.id;
  const customerId = subscription.customer;
  const status = subscription.status;

  // Find shop by subscription ID
  const shop = await prisma.shop.findFirst({
    where: { stripeSubscriptionId: subscriptionId },
  });

  if (!shop) {
    logger.warn('Shop not found for updated subscription', { subscriptionId });
    return;
  }

  // Extract planType from metadata
  const metadata = subscription.metadata || {};
  const planType = metadata.planType;

  // Map Stripe status to local status
  let newStatus = 'inactive';
  if (status === 'active' || status === 'trialing') {
    newStatus = 'active';
  } else if (
    status === 'cancelled' ||
    status === 'unpaid' ||
    status === 'incomplete_expired'
  ) {
    newStatus = 'cancelled';
  }

  // Update subscription
  const updateData = {};
  if (shop.subscriptionStatus !== newStatus) {
    updateData.subscriptionStatus = newStatus;
  }
  if (planType && shop.planType !== planType) {
    updateData.planType = planType;
  }

  if (Object.keys(updateData).length > 0) {
    await prisma.shop.update({
      where: { id: shop.id },
      data: updateData,
    });
  }
}
```

#### Step 5: Add Missing API Endpoints

**5.1 Add Portal Endpoint**

Add to `routes/subscriptions.js`:

```javascript
// GET /api/subscriptions/portal
r.get('/portal', ctrl.getPortal);
```

Add to `controllers/subscriptions.js`:

```javascript
export async function getPortal(req, res, next) {
  try {
    const shopId = getStoreId(req);
    const subscription = await getSubscriptionStatus(shopId);

    if (!subscription.stripeCustomerId) {
      return sendError(
        res,
        400,
        'MISSING_CUSTOMER_ID',
        'No payment account found'
      );
    }

    const { getCustomerPortalUrl } = require('../services/stripe.js');
    const baseUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const returnUrl = `${baseUrl}/shopify/app/billing`;

    const portalUrl = await getCustomerPortalUrl({
      customerId: subscription.stripeCustomerId,
      returnUrl,
    });

    return sendSuccess(res, { portalUrl });
  } catch (error) {
    logger.error('Get portal error', { error: error.message });
    next(error);
  }
}
```

#### Step 6: Seed Packages

**6.1 Create Seed Script**

Create `scripts/seed-packages.js`:

```javascript
import prisma from '../services/prisma.js';

const packages = [
  {
    name: 'Starter 500',
    units: 500,
    priceCents: 5000,
    stripePriceIdEur: process.env.STRIPE_PRICE_ID_500_EUR,
  },
  {
    name: 'Professional 2000',
    units: 2000,
    priceCents: 20000,
    stripePriceIdEur: process.env.STRIPE_PRICE_ID_2000_EUR,
  },
  // ... more packages
];

for (const pkg of packages) {
  await prisma.package.upsert({
    where: { name: pkg.name },
    update: pkg,
    create: { ...pkg, active: true },
  });
}
```

#### Step 7: Environment Variables

**7.1 Add Required Variables**

```bash
# Subscription Price IDs
STRIPE_PRICE_ID_SUB_STARTER_EUR=price_xxx
STRIPE_PRICE_ID_SUB_PRO_EUR=price_xxx

# Credit Top-up (optional)
STRIPE_PRICE_ID_CREDIT_TOPUP_EUR=price_xxx

# Package Price IDs (can also be in DB)
STRIPE_PRICE_ID_500_EUR=price_xxx
STRIPE_PRICE_ID_2000_EUR=price_xxx
```

#### Step 8: Testing

**8.1 Test All Flows**

- [ ] Subscription flow
- [ ] Renewal flow
- [ ] Credit top-up flow
- [ ] Credit package flow
- [ ] Payment failures
- [ ] Cancellation
- [ ] Refunds

---

## Frontend Integration

### Required API Calls

#### 1. Get Subscription Status

```javascript
const response = await fetch('/api/subscriptions/status', {
  headers: {
    Authorization: `Bearer ${token}`,
    'X-Shop-Domain': shopDomain,
  },
});
const { data } = await response.json();
const { active, planType, status } = data;
```

#### 2. Subscribe to Plan

```javascript
const response = await fetch('/api/subscriptions/subscribe', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    'X-Shop-Domain': shopDomain,
  },
  body: JSON.stringify({ planType: 'starter' }),
});
const { data } = await response.json();
window.location.href = data.checkoutUrl;
```

#### 3. Get Credit Packages

```javascript
const response = await fetch('/api/billing/packages', {
  headers: {
    Authorization: `Bearer ${token}`,
    'X-Shop-Domain': shopDomain,
  },
});
const { data } = await response.json();
const packages = data.packages; // Empty array if subscription not active
```

#### 4. Purchase Credit Package

```javascript
const response = await fetch('/api/billing/purchase', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    'X-Shop-Domain': shopDomain,
  },
  body: JSON.stringify({ packageId: 'pkg_xxx', currency: 'EUR' }),
});
const { data } = await response.json();
window.location.href = data.sessionUrl;
```

#### 5. Credit Top-up

```javascript
// Calculate price
const calcResponse = await fetch(`/api/billing/topup/calculate?credits=1000`, {
  headers: {
    Authorization: `Bearer ${token}`,
    'X-Shop-Domain': shopDomain,
  },
});
const price = await calcResponse.json();

// Create checkout
const response = await fetch('/api/billing/topup', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    'X-Shop-Domain': shopDomain,
  },
  body: JSON.stringify({ credits: 1000 }),
});
const { data } = await response.json();
window.location.href = data.checkoutUrl;
```

#### 6. Get Balance

```javascript
const response = await fetch('/api/billing/balance', {
  headers: {
    Authorization: `Bearer ${token}`,
    'X-Shop-Domain': shopDomain,
  },
});
const { data } = await response.json();
const balance = data.balance;
```

### Frontend Components

#### Subscription Card Component

```javascript
// Features:
// - Display current subscription status
// - Show plan details (price, credits)
// - Subscribe button (if not subscribed)
// - Manage/Cancel buttons (if subscribed)
// - Link to Stripe Customer Portal
```

#### Credit Packages Component

```javascript
// Features:
// - Display available packages (only if subscribed)
// - Show package details (credits, price)
// - Purchase button
// - Popular badge
```

#### Credit Top-up Component

```javascript
// Features:
// - Credit amount input
// - Price calculator
// - Price breakdown (base, VAT, total)
// - Purchase button
// - Available to all shops
```

#### Balance Display Component

```javascript
// Features:
// - Current balance
// - Subscription status
// - Recent transactions link
```

---

## Testing & Verification

### Manual Testing Checklist

#### Subscription Flow

- [ ] Shop can subscribe to Starter plan
- [ ] Shop can subscribe to Pro plan
- [ ] Webhook processes subscription correctly
- [ ] Free credits allocated on subscription
- [ ] Shop cannot subscribe if already subscribed
- [ ] Subscription status displayed correctly

#### Renewal Flow

- [ ] Renewal invoice processed correctly
- [ ] Free credits allocated on renewal
- [ ] Idempotency prevents duplicate allocations
- [ ] Billing period detection works correctly

#### Credit Top-up Flow

- [ ] Shop can calculate top-up price
- [ ] Shop can purchase top-up
- [ ] Webhook processes top-up correctly
- [ ] Credits added to wallet
- [ ] Idempotency prevents duplicate credits

#### Credit Packages Flow

- [ ] Packages only visible with subscription
- [ ] Shop can purchase package
- [ ] Webhook processes package correctly
- [ ] Credits added to wallet
- [ ] Purchase status updated

#### Payment Failures

- [ ] Payment failure updates subscription status
- [ ] Shop can update payment method
- [ ] Stripe retries payment correctly

#### Cancellation

- [ ] Shop can cancel subscription
- [ ] Subscription status updated to 'cancelled'
- [ ] Existing credits retained
- [ ] No future free credits allocated

### Automated Testing

#### Unit Tests

```javascript
// Test subscription service
describe('Subscription Service', () => {
  test('getFreeCreditsForPlan returns correct credits', () => {
    expect(getFreeCreditsForPlan('starter')).toBe(100);
    expect(getFreeCreditsForPlan('pro')).toBe(500);
  });

  test('calculateTopupPrice calculates correctly', () => {
    const result = calculateTopupPrice(1000);
    expect(result.priceEur).toBe(45.0);
    expect(result.vatAmount).toBe(10.8);
    expect(result.priceEurWithVat).toBe(55.8);
  });
});
```

#### Integration Tests

```javascript
// Test subscription flow
describe('Subscription Flow', () => {
  test('complete subscription flow', async () => {
    // 1. Create subscription checkout
    // 2. Simulate webhook
    // 3. Verify subscription active
    // 4. Verify credits allocated
  });
});
```

### Webhook Testing

Use Stripe CLI for local webhook testing:

```bash
stripe listen --forward-to localhost:3000/api/stripe/webhooks
stripe trigger checkout.session.completed
stripe trigger invoice.payment_succeeded
```

---

## Critical Implementation Notes

### 1. Credit Storage Consistency

**Problem:** Dual credit system (`Shop.credits` and `Wallet.balance`)

**Solution:**

- Migrate all credit operations to use `Wallet.balance` only
- Remove direct updates to `Shop.credits`
- Use `walletService` for all credit operations
- Update `billingService` to use `walletService`

### 2. Package Model Migration

**Problem:** Packages are hardcoded in service

**Solution:**

- Add `Package` model to database
- Migrate hardcoded packages to database
- Update `billingService.getPackages()` to query database
- Seed initial packages

### 3. Purchase Model Migration

**Problem:** Uses `BillingTransaction` instead of `Purchase`

**Solution:**

- Add `Purchase` model to database
- Migrate `BillingTransaction` records to `Purchase` records
- Update webhook handlers to use `Purchase` model
- Keep `BillingTransaction` for backward compatibility (deprecated)

### 4. Idempotency

**Always check for existing transactions before processing:**

- Subscription credits: Check `CreditTransaction` with `reason` and `meta.invoiceId`
- Top-ups: Check `CreditTransaction` with `reason: 'stripe:topup'` and `meta.sessionId`
- Packages: Check `Purchase.status = 'paid'`

### 5. Atomic Operations

**Always use transactions for wallet operations:**

- Wallet balance and transaction records updated together
- Prevents race conditions
- Ensures consistency

### 6. Error Handling

**Retryable Errors (return 500):**

- Database connection issues
- Network timeouts
- Temporary service unavailability

**Non-retryable Errors (return 200):**

- Validation errors
- Business logic errors
- Data not found

### 7. Webhook Ordering

**Handle race conditions:**

- `checkout.session.completed` handles first allocation
- `invoice.payment_succeeded` skips `subscription_create` invoices
- Only process `subscription_cycle` invoices for renewals

### 8. Credit Enforcement

**Always check balance before SMS sending:**

- Campaign enqueue: Check total credits needed
- SMS sending: Check balance before each message
- Return clear error if insufficient

---

## Summary

This document provides a complete technical guide for the Shopify backend pricing model. The system is designed to match the retail-backend implementation with the following key differences:

- **Entity Model:** Uses `Shop` instead of `User`
- **ID Type:** Uses `String` (CUID) instead of `Int`
- **Credit Storage:** Should use `Wallet.balance` consistently (currently dual system)
- **Package Storage:** Should use `Package` model (currently hardcoded)

The migration guide provides step-by-step instructions for:

1. Adding missing database models
2. Updating services to match retail-backend
3. Adding missing API endpoints
4. Updating webhook handlers
5. Migrating credit operations to use Wallet consistently

Once migrated, the Shopify backend will have feature parity with retail-backend for pricing and billing.

---

**Document Version:** 1.0  
**Last Updated:** 2025-01-XX  
**Maintained By:** Development Team
