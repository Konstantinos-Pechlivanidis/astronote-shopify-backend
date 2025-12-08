import { createClient } from 'redis';
import IORedis from 'ioredis';
import { logger } from '../utils/logger.js';

// Redis configuration from environment variables
const getRedisConfig = () => {
  const useTLS = process.env.REDIS_TLS === 'true';
  const baseConfig = {
    username: process.env.REDIS_USERNAME || 'default',
    password: process.env.REDIS_PASSWORD,
    socket: {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
    },
  };

  // TLS configuration for Redis Cloud
  // For Redis Cloud, TLS should be enabled with proper configuration
  if (useTLS) {
    baseConfig.socket.tls = {
      rejectUnauthorized: false, // Redis Cloud uses self-signed certificates
      servername: process.env.REDIS_HOST || 'localhost', // Required for TLS SNI
    };
  }

  return baseConfig;
};

// Create Redis connection using new redis client (for caching)
const createRedisClient = async () => {
  const config = getRedisConfig();

  const client = createClient({
    username: config.username,
    password: config.password,
    socket: config.socket,
  });

  // Error handling
  client.on('error', err => {
    logger.error('Redis Client Error', { error: err.message });
  });

  client.on('connect', () => {
    logger.info('Redis client connecting', {
      host: config.socket.host,
      port: config.socket.port,
    });
  });

  client.on('ready', () => {
    logger.info('Redis client ready', {
      host: config.socket.host,
      port: config.socket.port,
    });
  });

  client.on('reconnecting', () => {
    logger.info('Redis client reconnecting');
  });

  client.on('end', () => {
    logger.info('Redis client connection ended');
  });

  // Connect to Redis
  try {
    await client.connect();
    logger.info('Redis client connected successfully', {
      host: config.socket.host,
      port: config.socket.port,
    });
  } catch (error) {
    logger.error('Redis connection failed', { error: error.message });
    throw error;
  }

  return client;
};

// Skip Redis in test mode for faster tests
const skipRedis =
  process.env.NODE_ENV === 'test' && process.env.SKIP_REDIS === 'true';

// Mock Redis class for tests
class MockRedis {
  constructor() {
    this.status = 'ready';
    this.data = new Map();
  }

  async connect() {
    return Promise.resolve();
  }

  async disconnect() {
    return Promise.resolve();
  }

  async get(key) {
    return this.data.get(key) || null;
  }

  async set(key, value) {
    this.data.set(key, value);
    return 'OK';
  }

  async del(key) {
    return this.data.delete(key) ? 1 : 0;
  }

  async exists(key) {
    return this.data.has(key) ? 1 : 0;
  }

  async keys(_pattern) {
    return Array.from(this.data.keys());
  }

  async flushdb() {
    this.data.clear();
    return 'OK';
  }

  async ping() {
    return 'PONG';
  }

  async quit() {
    return Promise.resolve();
  }

  on() {
    return this;
  }

  once() {
    return this;
  }

  removeListener() {
    return this;
  }
}

// Redis connections
// Queue Redis uses ioredis (required by BullMQ)
export const queueRedis = skipRedis
  ? new MockRedis()
  : new IORedis({
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    username: process.env.REDIS_USERNAME || 'default',
    password: process.env.REDIS_PASSWORD,
    // TLS configuration for Redis Cloud
    // Note: For Redis Cloud, TLS is required and should be configured properly
    ...(process.env.REDIS_TLS === 'true'
      ? {
        tls: {
          rejectUnauthorized: false, // Redis Cloud uses self-signed certificates
          servername: process.env.REDIS_HOST || 'localhost', // Required for TLS SNI
        },
      }
      : {}),
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: true,
    connectTimeout: 10000,
    retryStrategy: times => {
      if (times > 3) {
        return null;
      }
      return Math.min(times * 200, 2000);
    },
  });

// Cache Redis (new redis client - lazy initialization)
let cacheRedisInstance = null;
let cacheRedisPromise = null;

export const cacheRedis = skipRedis
  ? new MockRedis()
  : {
    async connect() {
      if (!cacheRedisInstance) {
        if (!cacheRedisPromise) {
          cacheRedisPromise = createRedisClient();
        }
        cacheRedisInstance = await cacheRedisPromise;
      }
      return cacheRedisInstance;
    },
    async get(key) {
      const client = await this.connect();
      return client.get(key);
    },
    async set(key, value, options) {
      const client = await this.connect();
      if (options && typeof options === 'object') {
        return client.set(key, value, options);
      }
      return client.set(key, value);
    },
    async setex(key, seconds, value) {
      const client = await this.connect();
      return client.setEx(key, seconds, value);
    },
    async del(key) {
      const client = await this.connect();
      return client.del(key);
    },
    async exists(key) {
      const client = await this.connect();
      return client.exists(key);
    },
    async keys(_pattern) {
      const client = await this.connect();
      return client.keys(_pattern);
    },
    async flushdb() {
      const client = await this.connect();
      return client.flushDb();
    },
    async ping() {
      const client = await this.connect();
      return client.ping();
    },
    get status() {
      return cacheRedisInstance?.isReady ? 'ready' : 'connecting';
    },
    on() {
      return this;
    },
    once() {
      return this;
    },
    removeListener() {
      return this;
    },
  };

// Session Redis (new redis client - lazy initialization)
let sessionRedisInstance = null;
let sessionRedisPromise = null;

export const sessionRedis = skipRedis
  ? new MockRedis()
  : {
    async connect() {
      if (!sessionRedisInstance) {
        if (!sessionRedisPromise) {
          sessionRedisPromise = createRedisClient();
        }
        sessionRedisInstance = await sessionRedisPromise;
      }
      return sessionRedisInstance;
    },
    async get(key) {
      const client = await this.connect();
      return client.get(key);
    },
    async set(key, value, options) {
      const client = await this.connect();
      if (options && typeof options === 'object') {
        return client.set(key, value, options);
      }
      return client.set(key, value);
    },
    async setex(key, seconds, value) {
      const client = await this.connect();
      return client.setEx(key, seconds, value);
    },
    async del(key) {
      const client = await this.connect();
      return client.del(key);
    },
    async exists(key) {
      const client = await this.connect();
      return client.exists(key);
    },
    async keys(_pattern) {
      const client = await this.connect();
      return client.keys(_pattern);
    },
    async flushdb() {
      const client = await this.connect();
      return client.flushDb();
    },
    async ping() {
      const client = await this.connect();
      return client.ping();
    },
    get status() {
      return sessionRedisInstance?.isReady ? 'ready' : 'connecting';
    },
    on() {
      return this;
    },
    once() {
      return this;
    },
    removeListener() {
      return this;
    },
  };

// Health check function
export const checkRedisHealth = async redis => {
  try {
    const start = Date.now();
    let result;

    // Handle both ioredis and new redis client
    if (typeof redis.ping === 'function') {
      result = await redis.ping();
    } else if (redis.connect && typeof redis.connect === 'function') {
      const client = await redis.connect();
      result = await client.ping();
    } else {
      result = await redis.ping();
    }

    const latency = Date.now() - start;

    return {
      status: 'healthy',
      latency: `${latency}ms`,
      connected: result === 'PONG' || result === true,
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      error: error.message,
      connected: false,
    };
  }
};

// Graceful shutdown
export const closeRedisConnections = async () => {
  try {
    const promises = [];

    if (queueRedis && typeof queueRedis.quit === 'function') {
      promises.push(queueRedis.quit());
    }

    if (
      cacheRedisInstance &&
      typeof cacheRedisInstance.disconnect === 'function'
    ) {
      promises.push(cacheRedisInstance.disconnect());
    }

    if (
      sessionRedisInstance &&
      typeof sessionRedisInstance.disconnect === 'function'
    ) {
      promises.push(sessionRedisInstance.disconnect());
    }

    await Promise.all(promises);
    logger.info('Redis connections closed gracefully');
  } catch (error) {
    logger.error('Error closing Redis connections', { error: error.message });
  }
};
