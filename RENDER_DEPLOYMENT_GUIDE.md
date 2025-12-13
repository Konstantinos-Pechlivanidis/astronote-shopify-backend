# Render Deployment Guide - Fix Campaign Duplicates

## 🎯 Quick Fix Steps

### Step 1: Set Environment Variables on Render

Go to your **astronote-shopify-backend** service on Render Dashboard:

1. Click on your service
2. Go to **Environment** tab
3. Add/Update these variables:

```env
# ✅ CRITICAL - Frontend URL for unsubscribe links
FRONTEND_URL=https://astronote-shopify-frontend.onrender.com

# ✅ CRITICAL - Prevent duplicate scheduler runs
# Set to 'true' on PRIMARY instance only
# Set to 'false' on all WORKER instances
RUN_SCHEDULER=true

# ✅ Optional - Disable custom URL shortener
URL_SHORTENER_TYPE=none

# ✅ Verify these exist:
REDIS_URL=redis://...
MITTO_API_KEY=...
MITTO_API_BASE=https://rest.mitto.ch
DATABASE_URL=postgresql://...
JWT_SECRET=...
```

4. Click **Save Changes**
5. Render will automatically redeploy

### Step 2: Configure Instance Settings

**Option A: Single Instance (Simplest)**
- On Render: Set your service to run **1 instance only**
- This prevents scheduler conflicts
- Recommended for services with < 100 requests/second

**Option B: Multiple Instances with Scheduler Control**
1. Keep multiple instances for load balancing
2. Set `RUN_SCHEDULER=true` on **ONE instance only**
3. Set `RUN_SCHEDULER=false` on **ALL other instances**
4. The code now uses Redis lock for additional safety

### Step 3: Verify After Deployment

1. **Check Logs** on Render:
   ```
   ✅ Look for: "Scheduled campaigns processor started with distributed lock"
   ✅ Look for: "Scheduler lock acquired"
   ❌ Don't see 5x: "Enqueuing campaign for bulk SMS" for same campaign
   ```

2. **Test Campaign Send**:
   - Create a test campaign
   - Click "Send Now"
   - Check that message is sent **once**, not 5 times
   - Check that unsubscribe link works (not 404)

3. **Monitor Redis**:
   - Check for `scheduler:lock:campaigns` key in Redis
   - Should see lock being acquired/released properly

---

## 🔧 Troubleshooting

### Issue: Still seeing 5x messages

**Possible causes:**
1. Multiple Render services deployed (check you don't have duplicate services)
2. `RUN_SCHEDULER=true` on multiple instances
3. Old code still running (force redeploy)

**Fix:**
```bash
# On Render Dashboard:
1. Stop all instances
2. Clear Redis: redis-cli FLUSHDB (or manually delete scheduler:lock:* keys)
3. Verify environment variables
4. Start service
5. Watch logs for duplicate messages
```

### Issue: Unsubscribe still 404

**Possible causes:**
1. `FRONTEND_URL` not set or wrong
2. Frontend not deployed
3. URL still being shortened (check code is latest version)

**Fix:**
```bash
# Verify env var:
echo $FRONTEND_URL
# Should be: https://astronote-shopify-frontend.onrender.com

# Check SMS message in logs:
# Should see: "Unsubscribe: https://astronote-shopify-frontend.onrender.com/shopify/unsubscribe/TOKEN"
# Should NOT see: "Unsubscribe: https://.../s/SHORTCODE"
```

### Issue: Scheduler not running at all

**Symptoms**: Scheduled campaigns never send

**Fix:**
```bash
# Ensure at least ONE instance has RUN_SCHEDULER=true
# Check logs for: "Scheduled campaigns processor started with distributed lock"
```

---

## 📊 Verification Commands

### Check Campaign Duplicates:
```sql
-- Run in production database
SELECT 
  c.id,
  c.name,
  c.status,
  COUNT(DISTINCT cr.id) as recipient_count,
  COUNT(cr.id) as total_recipient_records,
  COUNT(cr.id) - COUNT(DISTINCT cr.id) as duplicates
FROM "Campaign" c
LEFT JOIN "CampaignRecipient" cr ON cr.campaign_id = c.id
WHERE c.created_at > NOW() - INTERVAL '1 day'
GROUP BY c.id, c.name, c.status
HAVING COUNT(cr.id) > COUNT(DISTINCT cr.id);
```

### Check Scheduler Locks in Redis:
```bash
# Connect to Redis
redis-cli

# Check for scheduler locks
KEYS scheduler:lock:*

# Get lock value
GET scheduler:lock:campaigns

# TTL remaining
TTL scheduler:lock:campaigns
```

---

## 🚀 Deployment Checklist

Before deploying:
- [ ] Code has Redis lock for scheduler
- [ ] Code has `RUN_SCHEDULER` env check
- [ ] `FRONTEND_URL` is set correctly
- [ ] Unsubscribe links don't use URL shortening
- [ ] Atomic status transition is in place

After deploying:
- [ ] Check logs for "distributed lock" messages
- [ ] Send test campaign - verify 1 message (not 5)
- [ ] Click unsubscribe link - verify it works (not 404)
- [ ] Check database for no duplicate recipients
- [ ] Monitor for 24 hours to ensure no regressions

---

## 📞 Emergency Rollback

If issues persist after deployment:

1. **Immediate**: Set `RUN_SCHEDULER=false` on ALL instances
   - This disables automatic scheduled campaigns
   - Manual sends still work

2. **Investigate**: Check Render logs for errors

3. **Rollback**: Revert to previous commit if needed
   ```bash
   git revert HEAD
   git push origin main
   ```

---

**Last Updated**: December 13, 2025  
**Priority**: 🔴 CRITICAL
