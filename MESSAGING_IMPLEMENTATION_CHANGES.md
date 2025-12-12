# Messaging Implementation Changes - Shopify Backend

**Date**: 2025-01-24  
**Purpose**: Implementation of Bulk SMS Architecture (aligned with Retail backend)

---

## 📋 Summary of Changes

### 🆕 New Files Created

1. **`services/smsBulk.js`**
   - Bulk SMS service με credit enforcement
   - Rate limiting checks (per-traffic-account, per-tenant)
   - Subscription validation
   - Unsubscribe links generation
   - Partial failure handling
   - Phase 2.1: Rate limit errors are retryable

2. **`services/rateLimiter.js`**
   - Distributed rate limiting με Redis
   - Per-traffic-account rate limiting (default: 100 req/s)
   - Per-tenant rate limiting (default: 50 req/s)
   - Combined limit checking (`checkAllLimits`)
   - Sliding window implementation

3. **`services/campaignAggregates.js`**
   - Campaign metrics calculation service
   - Phase 2.2 metrics: `sent` = actually sent, `processed` = sent + failed
   - Auto-update campaign status (sending → sent when all processed)
   - Recalculate aggregates function

4. **`queue/jobs/bulkSms.js`**
   - Worker handler για bulk SMS batch jobs
   - Processes `sendBulkSMS` job type
   - Message personalization (merge tags, discount codes)
   - Unsubscribe links appending
   - Idempotency checks
   - Phase 2.1: Retryable rate limit errors
   - Updates campaign aggregates after processing

5. **`routes/mitto-webhooks.js`** (created but not used - existing route used instead)
   - DLR webhook handler (alternative implementation)
   - Note: Actually updated `controllers/mitto.js` instead

---

### ✏️ Modified Files

#### **`services/mitto.js`**
- ✅ Added `sendBulkMessages()` function
  - Uses new Mitto endpoint: `POST /api/v1.1/Messages/sendmessagesbulk`
  - Validates response format (bulkId, messages array)
  - Returns `{ bulkId, messages, rawResponse }`
- ✅ Updated `sendSms()` to use `getSender()` helper
- ✅ Added `getSender()` function for sender resolution

#### **`services/campaigns.js`**
- ✅ Added `enqueueCampaign()` function
  - Builds audience OUTSIDE transaction (performance)
  - Validates subscription and credits BEFORE transaction
  - Creates CampaignRecipient records with `retryCount: 0`
  - Groups recipients into fixed-size batches (`SMS_BATCH_SIZE`)
  - Enqueues `sendBulkSMS` jobs to Redis queue
  - Returns `{ ok, created, enqueuedJobs, campaignId }`
- ✅ Updated `sendCampaign()` to call `enqueueCampaign()`
- ✅ Removed old single-message loop logic
- ✅ Removed unused functions: `streamRecipients()`
- ✅ Removed unused imports: `validateAndConsumeCredits`, `refundCredits`, `appendUnsubscribeLink`, `replacePlaceholders`, `getDiscountCode`
- ✅ Message personalization moved to worker (not stored in DB)

#### **`queue/worker.js`**
- ✅ Updated `smsWorker` to handle both job types:
  - `sendBulkSMS` → routes to `handleBulkSMS()`
  - `sendSMS` → routes to `handleMittoSend()` (for automations/test messages)
- ✅ Added import for `handleBulkSMS` from `queue/jobs/bulkSms.js`

#### **`controllers/campaigns.js`**
- ✅ Added `enqueue()` controller function
  - Handles `POST /campaigns/:id/enqueue`
  - Maps error reasons to HTTP status codes (404, 409, 400, 403, 402)
  - Returns `{ ok, created, enqueuedJobs, campaignId }`
- ✅ Added `status()` controller function
  - Handles `GET /campaigns/:id/status`
  - Returns Phase 2.2 metrics format:
    ```json
    {
      campaign: { id, name, status, total, sent, failed, processed },
      metrics: { queued, success, processed, failed }
    }
    ```
- ✅ `sendNow()` already uses `sendCampaign()` which calls `enqueueCampaign()`

#### **`routes/campaigns.js`**
- ✅ Added route: `POST /campaigns/:id/enqueue`
  - Uses `campaignSendRateLimit` middleware
  - Invalidates cache on success
- ✅ Added route: `GET /campaigns/:id/status`
  - Uses `campaignMetricsCache` middleware
- ✅ Exported new controller functions

#### **`controllers/mitto.js`**
- ✅ Updated `deliveryReport()` (DLR webhook handler)
  - Handles array of events (single or multiple)
  - Maps Mitto status to internal status (`mapStatus()` function)
  - Updates `CampaignRecipient` records by `mittoMessageId`
  - Updates `MessageLog` records
  - Updates campaign aggregates via `updateCampaignAggregates()`
  - Phase 2.2: Only tracks `sent` and `failed` (not `delivered` separately)
  - Returns 202 to avoid retry storms
  - Non-blocking aggregate updates (fire and forget)

#### **`prisma/schema.prisma`**
- ✅ `CampaignRecipient` model:
  - Added `bulkId String?` field (Mitto bulkId for batch tracking)
  - Added `retryCount Int @default(0)` field (for idempotency)
  - Added index: `@@index([bulkId])`
- ✅ `CampaignMetrics` model:
  - Added `totalProcessed Int @default(0)` field (Phase 2.2: sent + failed)
  - Note: `totalSent` = actually sent (status='sent'), not processed

---

### 🔧 Configuration Changes

#### **Environment Variables** (added to `.env`)
- `SMS_BATCH_SIZE` (default: 5000) - Fixed batch size for bulk SMS
- `RATE_LIMIT_TRAFFIC_ACCOUNT_MAX` (default: 100) - Per-traffic-account limit
- `RATE_LIMIT_TRAFFIC_ACCOUNT_WINDOW_MS` (default: 1000) - Window duration
- `RATE_LIMIT_TENANT_MAX` (default: 50) - Per-tenant limit
- `RATE_LIMIT_TENANT_WINDOW_MS` (default: 1000) - Window duration

---

### 🎯 Key Features Implemented

#### **1. Bulk SMS Architecture**
- ✅ Campaigns always use bulk endpoint (`/Messages/sendmessagesbulk`)
- ✅ Queue + Worker pattern (asynchronous processing)
- ✅ Fixed batch size (no dynamic batching)
- ✅ Idempotency (prevents duplicate sends)
- ✅ Partial failure handling

#### **2. Rate Limiting**
- ✅ Per-traffic-account rate limiting (100 req/s default)
- ✅ Per-tenant rate limiting (50 req/s default)
- ✅ Phase 2.1: Rate limit errors are retryable with exponential backoff
- ✅ Combined limit checking (both must pass)

#### **3. Campaign Metrics (Phase 2.2)**
- ✅ `sent` = only actually sent messages (status='sent')
- ✅ `processed` = sent + failed (total processed)
- ✅ `failed` = failed messages (status='failed')
- ✅ `queued` = pending messages (status='pending')
- ✅ Clear distinction in API and database

#### **4. Error Handling & Retries**
- ✅ Phase 2.1: Rate limit errors are retryable
- ✅ Exponential backoff (3s, 6s, 12s, 24s, 48s)
- ✅ Max 5 attempts (configurable)
- ✅ Retryable: network errors, 5xx, 429, rate_limit_exceeded
- ✅ Non-retryable: 4xx (except 429), invalid numbers

#### **5. Automations (Unchanged)**
- ✅ Automations continue using single send (`POST /Messages/send`)
- ✅ 1→1 messaging (appropriate for low volume)
- ✅ Synchronous processing (no queue)
- ✅ Same credit/unsubscribe logic as campaigns

#### **6. DLR Webhooks**
- ✅ Handles single or array of events
- ✅ Updates `CampaignRecipient` by `mittoMessageId`
- ✅ Updates `MessageLog` records
- ✅ Updates campaign aggregates (non-blocking)
- ✅ Status mapping: "Delivered" → "sent", "Failure" → "failed"
- ✅ Returns 202 to avoid retry storms

---

### 🚫 Removed/Deprecated

- ❌ Removed single-message loop in `sendCampaign()`
- ❌ Removed `streamRecipients()` function (not needed with bulk)
- ❌ Removed unused imports and variables
- ❌ Removed message text storage in `CampaignRecipient` (personalization in worker)

---

### 📊 API Endpoints

#### **New Endpoints**
1. `POST /campaigns/:id/enqueue`
   - Enqueues campaign for bulk SMS sending
   - Response: `{ ok: true, created: N, enqueuedJobs: N, campaignId: "..." }`
   - Errors: 404, 409, 400, 403, 402

2. `GET /campaigns/:id/status`
   - Returns campaign status with Phase 2.2 metrics
   - Response: `{ campaign: {...}, metrics: { queued, success, processed, failed } }`

#### **Existing Endpoints (Updated Behavior)**
- `POST /campaigns/:id/send` - Now uses `enqueueCampaign()` internally
- `GET /campaigns/:id/metrics` - Returns Phase 2.2 metrics format
- `POST /webhooks/mitto/dlr` - Updated for bulk SMS and Phase 2.2

---

### 🔄 Flow Changes

#### **Before (Legacy)**
```
User clicks "Send Campaign"
  → API receives request
  → For each contact:
      → Call Mitto API: POST /Messages/send
      → Wait for response
      → Update DB, debit credit
  → Update aggregates
```

#### **After (Bulk SMS)**
```
User clicks "Send Campaign"
  → API: POST /campaigns/:id/enqueue
  → Service: enqueueCampaign()
    → Build audience
    → Validate subscription/credits
    → Create CampaignRecipient records
    → Group into batches (SMS_BATCH_SIZE)
    → Enqueue sendBulkSMS jobs to Redis
  → Worker picks up job
    → Fetch recipients
    → Personalize messages
    → Call smsBulk.service.js
      → Check rate limits
      → Call mitto.service.js → sendBulkMessages()
      → Mitto API: POST /Messages/sendmessagesbulk
    → Update recipients with results
    → Update campaign aggregates
  → DLR webhook updates delivery status
  → Frontend polls GET /campaigns/:id/status
```

---

### ✅ Verification Checklist

- ✅ Lint: 0 errors, 0 warnings
- ✅ Prisma schema: Validated and generated
- ✅ Automations: Use single send (1-1 API) ✓
- ✅ Discounts: Not affected (used in worker for personalization) ✓
- ✅ Existing features: All preserved ✓
- ✅ Bulk SMS: Fully implemented ✓
- ✅ Rate limiting: Implemented ✓
- ✅ DLR webhooks: Updated for Phase 2.2 ✓
- ✅ Campaign metrics: Phase 2.2 format ✓

---

### 📝 Notes

1. **Message Personalization**: Moved to worker (`queue/jobs/bulkSms.js`) to avoid storing full message text in DB
2. **Discount Codes**: Fetched in worker when needed (not stored in CampaignRecipient)
3. **Unsubscribe Links**: Generated in worker for each message
4. **Idempotency**: Ensured via `mittoMessageId` checks and `retryCount` tracking
5. **Rate Limiting**: Phase 2.1 improvement - rate limit errors are retryable
6. **Metrics Clarity**: Phase 2.2 improvement - clear distinction between `sent`, `processed`, and `failed`

---

**Status**: ✅ Production-Ready  
**Aligned with**: Retail backend implementation  
**Documentation**: Based on `astronote-retail-backend/docs/MESSAGING_STACK_COMPLETE_REFERENCE.md`

