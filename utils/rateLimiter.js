// utils/rateLimiter.js
'use strict';

/**
 * Advanced Rate Limiter with Redis backend and multiple tiers
 * Supports different limits for different user roles and endpoints
 */

const redisClient = require('./redisClient');

class RateLimiter {
  constructor() {
    this.tiers = {
      // Free tier - basic limits
      free: {
        windowMs: 15 * 60 * 1000, // 15 minutes
        maxRequests: 100,
        burstLimit: 10, // Burst allowance
      },
      // Authenticated users
      user: {
        windowMs: 15 * 60 * 1000,
        maxRequests: 500,
        burstLimit: 50,
      },
      // Premium users (hospitals, dispatchers)
      premium: {
        windowMs: 15 * 60 * 1000,
        maxRequests: 2000,
        burstLimit: 200,
      },
      // Admin users
      admin: {
        windowMs: 15 * 60 * 1000,
        maxRequests: 10000,
        burstLimit: 1000,
      },
    };

    // Special limits for sensitive endpoints
    this.endpointLimits = {
      '/api/auth/login': { windowMs: 10 * 60 * 1000, max: 5 },
      '/api/auth/register': { windowMs: 60 * 60 * 1000, max: 3 },
      '/api/auth/forgot-password': { windowMs: 60 * 60 * 1000, max: 2 },
      '/api/auth/reset-password': { windowMs: 60 * 60 * 1000, max: 2 },
      '/api/emergency': { windowMs: 60 * 1000, max: 10 }, // Emergency requests - higher limit
    };
  }

  /**
   * Get rate limit key for user/IP
   */
  getKey(identifier, endpoint = '') {
    const cleanEndpoint = endpoint.replace(/\/$/, ''); // Remove trailing slash
    return `ratelimit:${identifier}:${cleanEndpoint}`;
  }

  /**
   * Get tier for user
   */
  getTier(user) {
    if (!user) return 'free';
    if (user.role === 'ADMIN') return 'admin';
    if (['HOSPITAL', 'DISPATCHER'].includes(user.role)) return 'premium';
    return 'user';
  }

  /**
   * Check rate limit for request
   */
  async checkLimit(identifier, endpoint = '', user = null) {
    const tier = this.getTier(user);
    const limits = this.endpointLimits[endpoint] || this.tiers[tier];
    const key = this.getKey(identifier, endpoint);

    try {
      // Use Redis sorted set to track requests with timestamps
      const now = Date.now();
      const windowStart = now - limits.windowMs;

      // Remove old requests outside the window
      await redisClient.zremrangebyscore(key, 0, windowStart);

      // Count current requests in window
      const requestCount = await redisClient.zcard(key);

      // Check burst limit (sliding window)
      const recentRequests = await redisClient.zcount(key, now - 60000, now); // Last minute

      if (requestCount >= limits.maxRequests || recentRequests >= limits.burstLimit) {
        const resetTime = await this.getResetTime(key, limits.windowMs);
        return {
          allowed: false,
          remaining: Math.max(0, limits.maxRequests - requestCount),
          resetTime,
          limit: limits.maxRequests,
          retryAfter: Math.ceil((resetTime - now) / 1000),
        };
      }

      // Add current request
      await redisClient.zadd(key, now, `${now}-${Math.random()}`);
      await redisClient.expire(key, Math.ceil(limits.windowMs / 1000));

      const newCount = requestCount + 1;

      return {
        allowed: true,
        remaining: Math.max(0, limits.maxRequests - newCount),
        resetTime: now + limits.windowMs,
        limit: limits.maxRequests,
      };

    } catch (error) {
      console.error('Rate limiter error:', error);
      // Fail open - allow request if Redis is down
      return {
        allowed: true,
        remaining: limits.maxRequests - 1,
        resetTime: Date.now() + limits.windowMs,
        limit: limits.maxRequests,
      };
    }
  }

  /**
   * Get reset time for key
   */
  async getResetTime(key, windowMs) {
    try {
      const oldestRequest = await redisClient.zrange(key, 0, 0, 'WITHSCORES');
      if (oldestRequest.length > 0) {
        return parseInt(oldestRequest[1]) + windowMs;
      }
      return Date.now() + windowMs;
    } catch (error) {
      return Date.now() + windowMs;
    }
  }

  /**
   * Clean up old rate limit keys (maintenance)
   */
  async cleanup() {
    try {
      const keys = await redisClient.keys('ratelimit:*');
      const now = Date.now();

      for (const key of keys) {
        const count = await redisClient.zcard(key);
        if (count === 0) {
          await redisClient.del(key);
        } else {
          // Remove entries older than 24 hours
          await redisClient.zremrangebyscore(key, 0, now - (24 * 60 * 60 * 1000));
        }
      }
    } catch (error) {
      console.error('Rate limiter cleanup error:', error);
    }
  }

  /**
   * Middleware for Express
   */
  middleware(options = {}) {
    return async (req, res, next) => {
      try {
        const identifier = req.user?.id || req.ip || req.connection.remoteAddress;
        const endpoint = req.path;

        const result = await this.checkLimit(identifier, endpoint, req.user);

        // Set rate limit headers
        res.set({
          'X-RateLimit-Limit': result.limit,
          'X-RateLimit-Remaining': result.remaining,
          'X-RateLimit-Reset': Math.ceil(result.resetTime / 1000),
        });

        if (!result.allowed) {
          res.set('Retry-After', result.retryAfter);
          return res.status(429).json({
            success: false,
            message: 'Too many requests, please try again later',
            retryAfter: result.retryAfter,
          });
        }

        next();
      } catch (error) {
        console.error('Rate limiter middleware error:', error);
        next(); // Fail open
      }
    };
  }
}

module.exports = new RateLimiter();