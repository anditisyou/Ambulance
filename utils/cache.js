// utils/cache.js
'use strict';

/**
 * Redis-based caching utility for API responses
 */

const redisClient = require('./redisClient');
const { isRedisAvailable } = require('./redisClient');
const logger = require('./logger');

class Cache {
  constructor() {
    this.defaultTTL = 300; // 5 minutes
  }

  isAvailable() {
    return isRedisAvailable() && Boolean(redisClient && typeof redisClient.get === 'function');
  }

  /**
   * Get cached value
   */
  async get(key) {
    if (!this.isAvailable()) return null;

    try {
      const value = await redisClient.get(key);
      return value ? JSON.parse(value) : null;
    } catch (error) {
      console.error('Cache get error:', error.message);
      return null;
    }
  }

  /**
   * Set cached value
   */
  async set(key, value, ttl = this.defaultTTL) {
    if (!this.isAvailable()) return;

    try {
      await redisClient.setex(key, ttl, JSON.stringify(value));
    } catch (error) {
      console.error('Cache set error:', error.message);
    }
  }

  /**
   * Delete cached value
   */
  async del(key) {
    if (!this.isAvailable()) return;

    try {
      await redisClient.del(key);
    } catch (error) {
      console.error('Cache del error:', error.message);
    }
  }

  /**
   * Delete all keys matching a Redis pattern.
   */
  async clearPattern(pattern) {
    if (!this.isAvailable()) return 0;

    let cursor = '0';
    let deleted = 0;

    do {
      const [nextCursor, keys] = await redisClient.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;

      if (Array.isArray(keys) && keys.length > 0) {
        deleted += await redisClient.del(...keys);
      }
    } while (cursor !== '0');

    return deleted;
  }

  /**
   * Invalidate cache patterns for emergency data
   */
  async invalidateEmergencyData() {
    try {
      await this.clearPattern('api:emergency:*');
      await this.clearPattern('api:ambulance:*');
      await this.clearPattern('api:hospital:*');
      logger.info('Invalidated emergency-related cache');
    } catch (error) {
      console.error('Cache invalidation error:', error.message);
    }
  }

  /**
   * Invalidate user-specific cache
   */
  async invalidateUserData(userId) {
    try {
      await this.clearPattern(`api:*user*${userId}*`);
      logger.info('Invalidated user cache', { userId });
    } catch (error) {
      console.error('User cache invalidation error:', error.message);
    }
  }

  /**
   * Middleware for API response caching
   */
  middleware(ttl = this.defaultTTL) {
    return async (req, res, next) => {
      // Only cache GET requests
      if (req.method !== 'GET') return next();

      // Skip caching for authenticated requests or dynamic data
      if (req.headers.authorization || req.user) return next();

      const key = `api:${req.originalUrl}`;

      try {
        const cached = await this.get(key);
        if (cached) {
          return res.json(cached);
        }
      } catch (error) {
        // Continue without cache
      }

      // Store original json method
      const originalJson = res.json;
      res.json = function(data) {
        // Cache successful responses only
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            cache.set(key, data, ttl);
          } catch (error) {
            // Silently fail
          }
        }
        return originalJson.call(this, data);
      };

      next();
    };
  }
}

const cache = new Cache();

module.exports = cache;
