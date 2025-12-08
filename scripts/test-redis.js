/* eslint-disable no-console */
// Console output is intentional for this test script
import IORedis from 'ioredis';
import 'dotenv/config';

console.log('🔧 Testing Redis Connection...\n');

// Display configuration (without sensitive data)
console.log('Configuration:');
console.log('- Host:', process.env.REDIS_HOST || 'Not set');
console.log('- Port:', process.env.REDIS_PORT || 'Not set');
console.log('- Username:', process.env.REDIS_USERNAME || 'Not set');
console.log(
  '- Password:',
  process.env.REDIS_PASSWORD
    ? `***${process.env.REDIS_PASSWORD.slice(-4)}`
    : 'Not set'
);
console.log('- TLS:', process.env.REDIS_TLS || 'Not set');
console.log('');

// Create Redis client
const redis = new IORedis({
  host: process.env.REDIS_HOST,
  port: parseInt(process.env.REDIS_PORT, 10),
  username: process.env.REDIS_USERNAME || 'default',
  password: process.env.REDIS_PASSWORD,
  // Redis Cloud requires TLS
  tls: process.env.REDIS_TLS === 'true' ? {} : undefined,
  // Timeouts
  connectTimeout: 30000,
  commandTimeout: 10000,
  // Keep alive
  keepAlive: 30000,
  // Retry strategy
  retryStrategy: times => {
    console.log(`⏳ Retry attempt ${times}...`);
    if (times > 3) {
      console.log('❌ Max retry attempts reached');
      return null;
    }
    return Math.min(times * 200, 2000);
  },
});

// Event handlers
redis.on('connect', () => {
  console.log('📡 Connecting to Redis...');
});

redis.on('ready', () => {
  console.log('✅ Redis connection ready!');
});

redis.on('error', err => {
  console.error('❌ Redis error:', err.message);
});

redis.on('close', () => {
  console.log('🔌 Redis connection closed');
});

redis.on('reconnecting', () => {
  console.log('🔄 Reconnecting to Redis...');
});

// Test operations
async function testRedis() {
  try {
    // Test 1: Ping
    console.log('\n📍 Test 1: Ping');
    const pong = await redis.ping();
    console.log('✅ Ping response:', pong);

    // Test 2: Set
    console.log('\n📍 Test 2: Set key');
    await redis.set('test:connection', 'success', 'EX', 60);
    console.log('✅ Key set successfully');

    // Test 3: Get
    console.log('\n📍 Test 3: Get key');
    const value = await redis.get('test:connection');
    console.log('✅ Key retrieved:', value);

    // Test 4: Delete
    console.log('\n📍 Test 4: Delete key');
    await redis.del('test:connection');
    console.log('✅ Key deleted successfully');

    // Test 5: Info
    console.log('\n📍 Test 5: Server info');
    const info = await redis.info('server');
    const version = info.match(/redis_version:([^\r\n]+)/)?.[1];
    console.log('✅ Redis version:', version);

    console.log('\n✅ All tests passed!');
    console.log('\n✨ Redis connection is working correctly');
  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    console.error('\n📋 Troubleshooting:');
    console.error('1. Check if REDIS_HOST and REDIS_PORT are correct');
    console.error('2. Verify REDIS_USERNAME and REDIS_PASSWORD');
    console.error('3. Ensure REDIS_TLS is set to "true" for Redis Cloud');
    console.error('4. Check if Redis Cloud firewall allows your IP');
    console.error('5. Verify Redis Cloud instance is running');
  } finally {
    await redis.quit();
    process.exit(0);
  }
}

// Wait for ready event before testing
redis.once('ready', () => {
  testRedis();
});

// Timeout if connection takes too long
setTimeout(() => {
  console.error('\n❌ Connection timeout (30 seconds)');
  console.error('\n📋 Check your Redis configuration and network connectivity');
  redis.disconnect();
  process.exit(1);
}, 30000);
