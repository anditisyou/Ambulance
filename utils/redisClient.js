'use strict';

/**
 * Redis client initialisation with health checks and graceful degradation.
 * Fails gracefully - auth middleware can fall back to in-memory blacklist when Redis is unavailable.
 * Supports both REDIS_URL and REDIS_HOST/REDIS_PORT formats.
 */
let redisClient = null;

try {
  redisClient = require('redis').createClient({
    url: process.env.REDIS_URL
  });

  redisClient.connect();
} catch (err) {
  console.log("Redis disabled");
}
let isRedisAvailable = false;

const shouldLog = process.env.NODE_ENV !== 'test';

const logRedisEvent = (level, message, err = null) => {
  if (!shouldLog) return;
  const prefix = `[Redis] ${level}:`;
  if (err) {
    console.warn(prefix, message, err.message || err);
  } else {
    console.info(prefix, message);
  }
};

const performHealthCheck = async (client) => {
  try {
    // Check eviction policy
    const policyResult = await client.config('GET', 'maxmemory-policy');
    const policy = policyResult?.[1] || 'unknown';

    if (policy !== 'noeviction') {
      logRedisEvent('WARNING', `Eviction policy is '${policy}'. Recommended: 'noeviction'`);
    } else {
      logRedisEvent('INFO', 'Eviction policy is correctly set to noeviction');
    }

    // Auto-fix if enabled
    if (policy !== 'noeviction' && process.env.FIX_REDIS_POLICY === 'true') {
      try {
        await client.config('SET', 'maxmemory-policy', 'noeviction');
        logRedisEvent('INFO', 'Automatically set eviction policy to noeviction');
      } catch (fixErr) {
        logRedisEvent('ERROR', 'Failed to auto-fix eviction policy', fixErr);
      }
    }

    // Test basic connectivity
    await client.ping();
    isRedisAvailable = true;
    logRedisEvent('INFO', 'Health check passed - Redis is available');
  } catch (err) {
    isRedisAvailable = false;
    logRedisEvent('ERROR', 'Health check failed - Redis unavailable', err);
    // Do NOT exit or throw - Redis is not fatal
  }
};

try {
  const hasRedisConfig = process.env.REDIS_URL || process.env.REDIS_HOST || process.env.REDIS_PORT;

  if (hasRedisConfig) {
    const Redis = require('ioredis');
    const redisTarget = process.env.REDIS_URL
      ? process.env.REDIS_URL
      : {
          host: process.env.REDIS_HOST || 'localhost',
          port: Number(process.env.REDIS_PORT || 6379),
          password: process.env.REDIS_PASSWORD || undefined,
        };

    redisClient = new Redis(redisTarget, {
      connectTimeout: 10000,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => Math.min(times * 50, 2000),
      reconnectOnError: (err) => {
        if (err.message.includes('ETIMEDOUT') || err.message.includes('ECONNRESET')) {
          return true;
        }
        return false;
      },
      autoResubscribe: true,
    });

    // Enhanced event handlers
    redisClient.on('error', (err) => {
      isRedisAvailable = false;
      logRedisEvent('ERROR', 'Connection error (non-fatal)', err);
    });

    redisClient.on('connect', () => {
      logRedisEvent('INFO', 'Connected to Redis');
    });

    redisClient.on('ready', async () => {
      logRedisEvent('INFO', 'Ready for commands');
      try {
        await performHealthCheck(redisClient);
      } catch (checkErr) {
        logRedisEvent('ERROR', 'Health check threw an error', checkErr);
        isRedisAvailable = false;
      }
    });

    redisClient.on('close', () => {
      isRedisAvailable = false;
      logRedisEvent('WARNING', 'Connection closed');
    });

    redisClient.on('reconnecting', (delay) => {
      logRedisEvent('WARNING', `Reconnecting in ${delay} ms`);
    });

    // Prevent unhandled error events
    redisClient.on('error', () => {
      // Already logged above, prevent crash
    });

  } else if (shouldLog) {
    console.warn('[Redis] REDIS not configured - running in degraded mode');
  }
} catch (err) {
  if (shouldLog) console.warn('[Redis] Failed to initialise - running in degraded mode:', err.message);
  redisClient = null;
  isRedisAvailable = false;
}

// Export both client and availability status
module.exports = redisClient;
module.exports.isRedisAvailable = () => isRedisAvailable;
