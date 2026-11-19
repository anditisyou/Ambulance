'use strict';

/**
 * Redis client initialisation.
 * Fails gracefully - auth middleware can fall back to in-memory blacklist when Redis is unavailable.
 * Supports both REDIS_URL and REDIS_HOST/REDIS_PORT formats.
 */
let redisClient = null;

const shouldLog = process.env.NODE_ENV !== 'test';

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

    const redisEventHandler = (level, err) => {
      if (shouldLog) console.warn(`[Redis] ${level}:`, err.message || err);
    };

    redisClient.on('error', (err) => redisEventHandler('Connection error (non-fatal)', err));
    redisClient.on('connect', () => {
      if (shouldLog) console.info('[Redis] Connected to Redis');
    });
    redisClient.on('ready', () => {
      if (shouldLog) console.info('[Redis] Ready for commands');
    });
    redisClient.on('close', () => {
      if (shouldLog) console.warn('[Redis] Connection closed');
    });
    redisClient.on('reconnecting', (delay) => {
      if (shouldLog) console.warn('[Redis] Reconnecting in', delay, 'ms');
    });
  } else if (shouldLog) {
    console.warn('[Redis] REDIS not configured - using in-memory token blacklist');
  }
} catch (err) {
  if (shouldLog) console.warn('[Redis] Failed to initialise - using in-memory token blacklist:', err.message);
  redisClient = null;
}

module.exports = redisClient;
