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
      lazyConnect:         true,
      enableOfflineQueue:  false,
      maxRetriesPerRequest: 1,
    });

    redisClient.on('error', (err) => {
      console.warn('[Redis] Connection error (non-fatal):', err.message);
    });

    redisClient.on('connect', () => {
      console.info('[Redis] Connected successfully');
    });
  } else {
    console.warn('[Redis] REDIS_URL not set — using in-memory token blacklist');
  }
} catch (err) {
  console.warn('[Redis] Failed to initialise — using in-memory token blacklist:', err.message);
  redisClient = null;
}

module.exports = redisClient;
