'use strict';

/**
 * Redis client initialisation.
 * Fails gracefully — the auth middleware will fall back to in-memory blacklist
 * when Redis is unavailable (e.g. local development without Redis).
 *
 * Production: set REDIS_URL in environment.
 * npm install ioredis
 */
let redisClient = null;

try {
  // Only attempt connection when REDIS_URL is configured
  if (process.env.REDIS_URL) {
    const Redis = require('ioredis');
    redisClient = new Redis(process.env.REDIS_URL, {
      connectTimeout:       10000,
      enableOfflineQueue:   false,
      maxRetriesPerRequest: 1,
      retryStrategy: (times) => Math.min(times * 50, 2000),
    });

    redisClient.on('error', (err) => {
      console.warn('[Redis] Connection error (non-fatal):', err.message);
    });

    redisClient.on('connect', () => {
      console.info('[Redis] Connected to Redis');
    });

    redisClient.on('ready', () => {
      console.info('[Redis] Ready for commands');
    });
  } else {
    console.warn('[Redis] REDIS_URL not set — using in-memory token blacklist');
  }
} catch (err) {
  console.warn('[Redis] Failed to initialise — using in-memory token blacklist:', err.message);
  redisClient = null;
}

module.exports = redisClient;
