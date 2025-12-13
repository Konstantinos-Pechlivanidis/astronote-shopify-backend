import dotenv from 'dotenv';
dotenv.config();

/**
 * Production Configuration Verification Script
 * Run this script to verify that all critical environment variables are set correctly
 * 
 * Usage: node scripts/verify-production.js
 */

const errors = [];
const warnings = [];
const info = [];

console.log('\n🔍 Verifying Production Configuration...\n');

// Critical environment variables
const critical = {
  'FRONTEND_URL or FRONTEND_BASE_URL': process.env.FRONTEND_URL || process.env.FRONTEND_BASE_URL,
  'REDIS_URL': process.env.REDIS_URL,
  'MITTO_API_KEY': process.env.MITTO_API_KEY,
  'MITTO_API_BASE': process.env.MITTO_API_BASE,
  'JWT_SECRET': process.env.JWT_SECRET,
  'DATABASE_URL': process.env.DATABASE_URL,
};

// Check critical variables
for (const [name, value] of Object.entries(critical)) {
  if (!value) {
    errors.push(`❌ ${name} is not set`);
  } else {
    info.push(`✅ ${name} is set`);
    
    // Show partial value for verification (security-safe)
    if (name === 'FRONTEND_URL or FRONTEND_BASE_URL') {
      console.log(`   Value: ${value}`);
    } else if (name.includes('URL') || name.includes('BASE')) {
      console.log(`   Value: ${value.substring(0, 30)}...`);
    } else {
      console.log(`   Value: ${value.substring(0, 10)}***`);
    }
  }
}

// Check scheduler configuration
if (process.env.RUN_SCHEDULER === 'false') {
  warnings.push(`⚠️  RUN_SCHEDULER=false - Scheduled campaigns will NOT run automatically`);
  console.log('\n⚠️  SCHEDULER DISABLED: Set RUN_SCHEDULER=true on at least ONE instance\n');
} else {
  info.push(`✅ RUN_SCHEDULER enabled (default: true)`);
}

// Check for multiple instances warning
if (process.env.RENDER_INSTANCE_COUNT) {
  const instanceCount = parseInt(process.env.RENDER_INSTANCE_COUNT);
  if (instanceCount > 1) {
    warnings.push(`⚠️  Running ${instanceCount} instances - ensure scheduler uses Redis lock`);
    console.log(`\n⚠️  MULTIPLE INSTANCES DETECTED: ${instanceCount} instances`);
    console.log(`   → Scheduler now uses Redis lock to prevent duplicates`);
    console.log(`   → Each instance will coordinate via Redis\n`);
  }
}

// Check URL shortener config
const shortenerType = process.env.URL_SHORTENER_TYPE || 'custom';
if (shortenerType === 'custom') {
  warnings.push(`⚠️  Using custom URL shortener - ensure /s/:shortCode route exists or disable shortening`);
  console.log(`\n⚠️  CUSTOM URL SHORTENER: Unsubscribe links should NOT be shortened`);
  console.log(`   → Current config: URL_SHORTENER_TYPE=${shortenerType}`);
  console.log(`   → Unsubscribe URLs now use full paths (fixed in latest commit)\n`);
}

// Check if running in production
if (process.env.NODE_ENV !== 'production') {
  warnings.push(`⚠️  NODE_ENV=${process.env.NODE_ENV} (should be 'production')`);
}

// Print summary
console.log('\n' + '='.repeat(60));
console.log('VERIFICATION SUMMARY');
console.log('='.repeat(60) + '\n');

if (errors.length > 0) {
  console.log('🔴 ERRORS (Must Fix):');
  errors.forEach(err => console.log(`   ${err}`));
  console.log('');
}

if (warnings.length > 0) {
  console.log('🟡 WARNINGS (Review):');
  warnings.forEach(warn => console.log(`   ${warn}`));
  console.log('');
}

console.log('✅ PASSED CHECKS:');
info.forEach(i => console.log(`   ${i}`));
console.log('');

// Exit with appropriate code
if (errors.length > 0) {
  console.log('❌ Configuration has CRITICAL errors - fix before deploying\n');
  process.exit(1);
} else if (warnings.length > 0) {
  console.log('⚠️  Configuration has warnings - review before deploying\n');
  process.exit(0); // Don't block deployment for warnings
} else {
  console.log('✅ All checks passed - configuration looks good!\n');
  process.exit(0);
}
