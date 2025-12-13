# URGENT FIX GUIDE - Campaign Duplicates & Unsubscribe 404

**Date**: December 13, 2025  
**Status**: 🔴 CRITICAL - Production Issues

---

## 🐛 Reported Issues

1. **Campaigns send 5 messages instead of 1** (after redeploy)
2. **Unsubscribe links lead to 404 errors**

---

## 🔍 Root Cause Analysis

### Issue #1: 5x Message Duplicates

**Primary Cause**: Multiple backend instances running schedulers simultaneously

When Render/Heroku runs multiple instances (horizontal scaling):
- Each instance runs its own `startScheduledCampaignsProcessor()`
- All instances check for due campaigns **at the same time**
- All instances try to queue the same campaign
- Result: **5 instances = 5x sends**

**Secondary Causes**:
- BullMQ jobId deduplication may not work across Redis connections
- Race conditions in status updates when multiple instances hit database simultaneously

### Issue #2: Unsubscribe 404 Errors

**Root Cause**: Missing `FRONTEND_URL` environment variable in production

The backend generates:
```javascript
const frontendBaseUrl = process.env.FRONTEND_URL || process.env.FRONTEND_BASE_URL || 'https://astronote-shopify-frontend.onrender.com';
const url = `${frontendBaseUrl}/shopify/unsubscribe/${token}`;
```

If `FRONTEND_URL` is not set or is wrong, URLs will be incorrect.

---

## ✅ IMMEDIATE FIXES

### Fix #1: Disable Scheduler on Worker Instances

**Option A: Use Single Instance for Scheduler (Recommended)**

Add environment variable to control scheduler:

```env
# On Render Dashboard - Add this env variable:
RUN_SCHEDULER=true  # Only on ONE instance

# Or for all instances:
RUN_SCHEDULER=false  # Disable scheduler entirely (manual campaign sends only)
```

**Implementation:**

File: `services/scheduler.js`

```javascript
export function startScheduledCampaignsProcessor() {
  // Skip if scheduler is disabled
  if (process.env.RUN_SCHEDULER === 'false') {
    logger.info('Scheduled campaigns processor disabled (RUN_SCHEDULER=false)');
    return;
  }

  // Skip in test mode
  if (process.env.NODE_ENV === 'test' && process.env.SKIP_QUEUES === 'true') {
    logger.info('Skipping scheduled campaigns processor in test mode');
    return;
  }

  // ... rest of code
}
```

**Option B: Use Redis Lock for Distributed Scheduler**

Better solution for production with multiple instances:

```javascript
// In scheduler.js - add distributed lock
async function acquireSchedulerLock() {
  const { queueRedis } = await import('../config/redis.js');
  const lockKey = 'scheduler:lock:campaigns';
  const lockTTL = 60; // 60 seconds
  
  const acquired = await queueRedis.set(lockKey, Date.now(), 'EX', lockTTL, 'NX');
  return acquired === 'OK';
}

export function startScheduledCampaignsProcessor() {
  // ... skip checks ...

  function processNextBatch() {
    try {
      // Only process if we can acquire the lock
      acquireSchedulerLock().then(hasLock => {
        if (!hasLock) {
          logger.debug('Another instance is running the scheduler, skipping');
          return;
        }
        
        processScheduledCampaigns()
          .then(result => {
            if (result.queued > 0) {
              logger.info('Scheduled campaigns processed', result);
            }
          })
          .catch(error => {
            logger.error('Error in scheduled campaigns processor', {
              error: error.message,
            });
          });
      });

      setTimeout(processNextBatch, INTERVAL_MS);
    } catch (error) {
      logger.error('Failed to process scheduled campaigns', {
        error: error.message,
      });
      setTimeout(processNextBatch, INTERVAL_MS);
    }
  }
  
  // ... rest
}
```

### Fix #2: Set Correct Environment Variables

**On Render Dashboard:**

1. Go to your backend service
2. Go to "Environment" tab
3. Add/Update these variables:

```env
# Frontend URL - CRITICAL
FRONTEND_URL=https://astronote-shopify-frontend.onrender.com

# Or if you have custom domain:
FRONTEND_URL=https://your-custom-domain.com

# Verify these are also set:
REDIS_URL=redis://...
MITTO_API_BASE=https://rest.mitto.ch
MITTO_API_KEY=your_key
```

4. Click "Save Changes"
5. Redeploy

### Fix #3: Add Deployment Check Script

Create a script to verify production config:

File: `scripts/verify-production.js`

```javascript
import { logger } from '../utils/logger.js';

async function verifyProductionConfig() {
  const errors = [];
  const warnings = [];

  // Check critical env vars
  if (!process.env.FRONTEND_URL && !process.env.FRONTEND_BASE_URL) {
    errors.push('FRONTEND_URL or FRONTEND_BASE_URL must be set');
  }

  if (!process.env.REDIS_URL) {
    errors.push('REDIS_URL must be set for production');
  }

  if (!process.env.MITTO_API_KEY) {
    errors.push('MITTO_API_KEY must be set');
  }

  // Check instance count warning
  if (process.env.RENDER_INSTANCE_COUNT && parseInt(process.env.RENDER_INSTANCE_COUNT) > 1) {
    if (process.env.RUN_SCHEDULER !== 'false') {
      warnings.push(`Running ${process.env.RENDER_INSTANCE_COUNT} instances with scheduler enabled may cause duplicates`);
    }
  }

  logger.info('Production config verification', {
    errors: errors.length,
    warnings: warnings.length,
  });

  if (errors.length > 0) {
    logger.error('Production config errors:', { errors });
    throw new Error('Production configuration is invalid');
  }

  if (warnings.length > 0) {
    logger.warn('Production config warnings:', { warnings });
  }

  logger.info('Production config verified successfully');
}

// Run on startup
verifyProductionConfig().catch(error => {
  logger.error('Failed to verify production config', { error: error.message });
  process.exit(1);
});
```

Add to `index.js`:

```javascript
// After environment validation
import './scripts/verify-production.js';
```

---

## 🧪 TESTING CHECKLIST

### Before Deploying:

- [ ] Set `RUN_SCHEDULER=false` on ALL Render instances
- [ ] Set `FRONTEND_URL` correctly
- [ ] Verify Redis is accessible
- [ ] Check that only 1 backend instance is running (or use Redis lock)

### After Deploying:

1. **Test Campaign Send (Once)**:
   ```bash
   # Check logs for:
   - "Enqueuing campaign for bulk SMS"
   - Should appear ONCE, not 5 times
   ```

2. **Test Unsubscribe Link**:
   ```bash
   # Send a test campaign
   # Check SMS message
   # Click unsubscribe link
   # Should go to: https://astronote-shopify-frontend.onrender.com/shopify/unsubscribe/TOKEN
   # Should NOT be 404
   ```

3. **Monitor Logs**:
   ```bash
   # Check for:
   - "Campaign already sending" warnings (good - means dedup is working)
   - "Duplicate enqueue attempt blocked" (good)
   - Any errors about status transitions
   ```

---

## 📊 VERIFICATION QUERIES

Run these in production database to verify:

```sql
-- Check for campaigns stuck in 'sending' status
SELECT id, name, status, created_at, updated_at 
FROM "Campaign" 
WHERE status = 'sending' 
  AND updated_at < NOW() - INTERVAL '1 hour';

-- Check for duplicate campaign recipients
SELECT campaign_id, phone_e164, COUNT(*) as count
FROM "CampaignRecipient"
GROUP BY campaign_id, phone_e164
HAVING COUNT(*) > 1;

-- Check recent campaign sends
SELECT c.id, c.name, c.status, COUNT(cr.id) as recipient_count
FROM "Campaign" c
LEFT JOIN "CampaignRecipient" cr ON cr.campaign_id = c.id
WHERE c.created_at > NOW() - INTERVAL '1 day'
GROUP BY c.id, c.name, c.status
ORDER BY c.created_at DESC;
```

---

## 🚀 DEPLOYMENT STEPS

### Step 1: Update Code

```bash
cd astronote-shopify-backend

# Apply Fix #1 (Scheduler lock)
# Edit services/scheduler.js - add Redis lock

git add services/scheduler.js
git commit -m "fix: Add Redis lock to prevent duplicate scheduler runs across instances"
git push origin main
```

### Step 2: Update Render Config

1. Go to Render Dashboard → Your Backend Service
2. Environment Tab
3. Add/Update:
   - `FRONTEND_URL=https://astronote-shopify-frontend.onrender.com`
   - `RUN_SCHEDULER=true` (on primary instance only)
4. Save

### Step 3: Redeploy

1. Trigger manual deploy on Render
2. Wait for deployment to complete
3. Check logs for "Production config verified successfully"

### Step 4: Verify

1. Send a test campaign
2. Check that it sends ONCE (not 5 times)
3. Click unsubscribe link - should work (not 404)

---

## 🔧 ALTERNATIVE: Quick Disable Scheduler

If you need an IMMEDIATE fix without code changes:

```env
# On Render - set this env var:
RUN_SCHEDULER=false
```

Then modify `services/scheduler.js` line 146:

```javascript
export function startScheduledCampaignsProcessor() {
  // EMERGENCY DISABLE
  if (process.env.RUN_SCHEDULER === 'false') {
    logger.info('Scheduler disabled via RUN_SCHEDULER env var');
    return;
  }
  // ... rest of code
}
```

This will disable ALL scheduled campaigns (manual sends still work).

---

## 📞 SUPPORT

If issues persist after applying these fixes:

1. Check Render logs for errors
2. Verify environment variables are set correctly
3. Ensure only 1 backend instance is running
4. Check Redis connection is stable
5. Verify database queries show no duplicates

---

## ✅ SUCCESS CRITERIA

- [x] Code has atomic status transitions
- [x] Frontend buttons have disabled state
- [x] Unsubscribe URLs use full paths (not shortened)
- [ ] Scheduler uses Redis lock OR runs on single instance only
- [ ] Environment variables are correctly set in production
- [ ] Only 1 message sent per campaign
- [ ] Unsubscribe links work (no 404)

---

**Last Updated**: December 13, 2025  
**Priority**: 🔴 CRITICAL  
**Estimated Fix Time**: 15-30 minutes
