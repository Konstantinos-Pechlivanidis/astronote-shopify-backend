# Πλάνο Διορθώσεων/Βελτιώσεων: Send Campaigns

**Ημερομηνία**: 2025-12-13  
**Βάσει**: CAMPAIGN_SEND_EVALUATION.md

---

## Priority 1: Critical (Before Production) 🔴

### 1.1 Credit Reservation System
**Issue**: Credits checked upfront, but if credits run out mid-campaign, remaining batches fail silently.

**Solution**:
```javascript
// services/campaigns.js - enqueueCampaign()
// Reserve credits at campaign start
const { reserveCredits, releaseCredits } = await import('./wallet.js');
const reservationId = await reserveCredits(storeId, requiredCredits, {
  campaignId,
  expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24h
});

// On campaign completion/failure, release unused credits
await releaseCredits(reservationId);
```

**Files to Modify**:
- `services/campaigns.js` - Add credit reservation
- `services/wallet.js` - Add `reserveCredits()` and `releaseCredits()` methods
- `queue/jobs/bulkSms.js` - Release credits on completion/failure

**Estimated Effort**: 4-6 hours

---

### 1.2 Progress Tracking Endpoint
**Issue**: User doesn't know how many messages sent out of total.

**Solution**:
```javascript
// controllers/campaigns.js
export async function getCampaignProgress(req, res, next) {
  const { id } = req.params;
  const storeId = getStoreId(req);
  
  const [total, sent, failed, pending] = await Promise.all([
    prisma.campaignRecipient.count({ where: { campaignId: id } }),
    prisma.campaignRecipient.count({ where: { campaignId: id, status: 'sent' } }),
    prisma.campaignRecipient.count({ where: { campaignId: id, status: 'failed' } }),
    prisma.campaignRecipient.count({ where: { campaignId: id, status: 'pending' } }),
  ]);
  
  return res.json({
    total,
    sent,
    failed,
    pending,
    processed: sent + failed,
    progress: total > 0 ? Math.round(((sent + failed) / total) * 100) : 0,
  });
}
```

**Files to Create/Modify**:
- `controllers/campaigns.js` - Add `getCampaignProgress()`
- `routes/campaigns.js` - Add `GET /campaigns/:id/progress`
- `frontend/src/services/queries.js` - Add `useCampaignProgress()` hook
- `frontend/src/pages/app/CampaignDetail.jsx` - Add progress bar component

**Estimated Effort**: 3-4 hours

---

### 1.3 Cancel Send Functionality
**Issue**: Once campaign starts, can't be stopped.

**Solution**:
```javascript
// services/campaigns.js
export async function cancelCampaign(storeId, campaignId) {
  // 1. Update campaign status to 'cancelled'
  await prisma.campaign.updateMany({
    where: { id: campaignId, shopId: storeId, status: CampaignStatus.sending },
    data: { status: CampaignStatus.cancelled, updatedAt: new Date() },
  });
  
  // 2. Remove pending jobs from queue
  const pendingJobs = await smsQueue.getJobs(['waiting', 'delayed'], 0, -1);
  for (const job of pendingJobs) {
    if (job.data?.campaignId === campaignId) {
      await job.remove();
    }
  }
  
  // 3. Mark pending recipients as cancelled
  await prisma.campaignRecipient.updateMany({
    where: { campaignId, status: 'pending' },
    data: { status: 'cancelled', updatedAt: new Date() },
  });
  
  // 4. Release reserved credits
  // ... (use credit reservation system)
}
```

**Files to Create/Modify**:
- `services/campaigns.js` - Add `cancelCampaign()`
- `controllers/campaigns.js` - Add `cancel()` controller
- `routes/campaigns.js` - Add `POST /campaigns/:id/cancel`
- `frontend/src/services/queries.js` - Add `useCancelCampaign()` hook
- `frontend/src/pages/app/CampaignDetail.jsx` - Add cancel button

**Estimated Effort**: 4-5 hours

---

### 1.4 Recipient Count Preview
**Issue**: User doesn't know how many will receive before sending.

**Solution**:
```javascript
// controllers/campaigns.js
export async function getCampaignPreview(req, res, next) {
  const { id } = req.params;
  const storeId = getStoreId(req);
  
  const campaign = await prisma.campaign.findUnique({
    where: { id, shopId: storeId },
  });
  
  if (!campaign) {
    return res.status(404).json({ ok: false, message: 'Campaign not found' });
  }
  
  // Resolve recipients (same logic as enqueueCampaign)
  const contacts = await resolveRecipients(storeId, campaign.audience);
  
  return res.json({
    ok: true,
    recipientCount: contacts.length,
    estimatedCost: contacts.length, // 1 credit per SMS
    canSend: contacts.length > 0,
  });
}
```

**Files to Create/Modify**:
- `controllers/campaigns.js` - Add `getCampaignPreview()`
- `routes/campaigns.js` - Add `GET /campaigns/:id/preview`
- `frontend/src/services/queries.js` - Add `useCampaignPreview()` hook
- `frontend/src/pages/app/CampaignDetail.jsx` - Show preview in send confirmation dialog

**Estimated Effort**: 3-4 hours

---

## Priority 2: Important (Next Sprint) 🟡

### 2.1 Manual Retry UI
**Issue**: Backend has retry endpoint, but no frontend button.

**Solution**:
- Add "Retry Failed" button in `CampaignDetail.jsx`
- Button only visible when campaign has failed recipients
- Use existing `POST /campaigns/:id/retry-failed` endpoint

**Files to Modify**:
- `frontend/src/pages/app/CampaignDetail.jsx` - Add retry button
- `frontend/src/services/queries.js` - Add `useRetryFailedCampaign()` hook (if not exists)

**Estimated Effort**: 1-2 hours

---

### 2.2 Improved Error Messages
**Issue**: Generic error messages, no breakdown.

**Solution**:
```javascript
// controllers/campaigns.js - enqueue()
if (!result.ok) {
  // Enhanced error response
  return res.status(400).json({
    ok: false,
    message: result.message || 'Campaign cannot be enqueued',
    code: result.reason,
    details: result.details || {}, // Additional context
    actionable: result.actionable || false, // Can user fix this?
  });
}
```

**Files to Modify**:
- `services/campaigns.js` - Return detailed error objects
- `controllers/campaigns.js` - Format detailed errors
- `frontend/src/pages/app/CampaignDetail.jsx` - Display detailed errors

**Estimated Effort**: 2-3 hours

---

### 2.3 Queue Monitoring
**Issue**: No visibility into queue depth, processing rate.

**Solution**:
```javascript
// controllers/campaigns.js
export async function getQueueStats(req, res, next) {
  const [waiting, active, completed, failed] = await Promise.all([
    smsQueue.getWaitingCount(),
    smsQueue.getActiveCount(),
    smsQueue.getCompletedCount(),
    smsQueue.getFailedCount(),
  ]);
  
  return res.json({
    waiting,
    active,
    completed,
    failed,
    total: waiting + active,
  });
}
```

**Files to Create/Modify**:
- `controllers/campaigns.js` - Add `getQueueStats()`
- `routes/campaigns.js` - Add `GET /campaigns/queue/stats` (admin only)
- `frontend/src/pages/app/Dashboard.jsx` - Add queue stats widget

**Estimated Effort**: 2-3 hours

---

## Priority 3: Nice to Have (Future) 🟢

### 3.1 WebSocket/SSE for Real-time Updates
**Issue**: Polling-based updates, not true real-time.

**Solution**:
- Implement WebSocket server for campaign status updates
- Replace `refetchInterval` with WebSocket subscriptions
- Fallback to polling if WebSocket unavailable

**Estimated Effort**: 8-12 hours

---

### 3.2 Priority Queues
**Issue**: All campaigns processed with same priority.

**Solution**:
- Add `priority` field to Campaign model
- Use BullMQ priority queues
- UI to set campaign priority

**Estimated Effort**: 4-6 hours

---

### 3.3 Delivery Status Tracking
**Issue**: No delivery status per message (only sent/failed).

**Solution**:
- Use Mitto webhooks for delivery status
- Update `CampaignRecipient.deliveryStatus` field
- Show delivery status in UI

**Estimated Effort**: 6-8 hours

---

### 3.4 Click Tracking
**Issue**: No tracking of unsubscribe link clicks.

**Solution**:
- Add click tracking to unsubscribe links
- Store click events in database
- Show click metrics in campaign details

**Estimated Effort**: 4-6 hours

---

### 3.5 Send Confirmation Dialog
**Issue**: User can accidentally send campaign.

**Solution**:
- Add confirmation dialog before send
- Show recipient count, estimated cost
- Require explicit confirmation

**Estimated Effort**: 2-3 hours

---

## Implementation Timeline

### Week 1 (Critical)
- [ ] Credit Reservation System (4-6h)
- [ ] Progress Tracking (3-4h)
- [ ] Cancel Send (4-5h)
- [ ] Recipient Preview (3-4h)
**Total**: ~15-19 hours

### Week 2 (Important)
- [ ] Manual Retry UI (1-2h)
- [ ] Improved Error Messages (2-3h)
- [ ] Queue Monitoring (2-3h)
**Total**: ~5-8 hours

### Week 3+ (Nice to Have)
- [ ] WebSocket/SSE (8-12h)
- [ ] Priority Queues (4-6h)
- [ ] Delivery Tracking (6-8h)
- [ ] Click Tracking (4-6h)
- [ ] Send Confirmation (2-3h)
**Total**: ~24-35 hours

---

## Testing Checklist

### For Each Feature:
- [ ] Unit tests for service functions
- [ ] Integration tests for API endpoints
- [ ] E2E tests for frontend flows
- [ ] Error case testing
- [ ] Edge case testing
- [ ] Performance testing (for queue features)

### Specific Test Cases:
- [ ] Credit reservation/release on success
- [ ] Credit reservation/release on failure
- [ ] Progress updates during send
- [ ] Cancel stops pending jobs
- [ ] Preview shows accurate count
- [ ] Retry only retries failed recipients
- [ ] Error messages are actionable
- [ ] Queue stats are accurate

---

## Notes

- All Priority 1 items should be completed before production deployment
- Priority 2 items improve UX and observability
- Priority 3 items are enhancements for future releases
- Each feature should be tested thoroughly before merging
- Consider feature flags for gradual rollout
