'use strict';

const logger = require('./logger');

/**
 * Event Consistency Manager
 * Ensures strict event ordering and prevents stale updates
 * Uses Redis streams for distributed event tracking
 */

const redisConnection = {
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
};

let redis = null;
let isRedisAvailable = false;

const createNoopRedisClient = () => {
  const noop = async () => null;
  const noopArray = async () => [];

  const client = {
    status: 'down',
    connect: noop,
    disconnect: noop,
    quit: noop,
    duplicate: () => client,
    on: () => {},
    once: () => {},
    removeAllListeners: () => {},
    xinfo: async () => { throw new Error('Redis unavailable'); },
    xgroup: noop,
    xadd: async () => null,
    xrange: noopArray,
    get: noop,
    set: noop,
    publish: noop,
    info: async () => '',
  };

  return client;
};

const initializeRedis = () => {
  try {
    const Redis = require('ioredis');
    redis = new Redis(redisConnection, {
      connectTimeout: 10000,
      enableOfflineQueue: true,
      maxRetriesPerRequest: 10,
      retryStrategy: (times) => Math.min(times * 50, 2000),
      reconnectOnError: (err) => {
        const msg = err?.message || '';
        return /ETIMEDOUT|ECONNRESET|ECONNREFUSED|EHOSTUNREACH|ECONNABORTED/.test(msg);
      },
      autoResubscribe: true,
    });

    redis.on('error', (err) => {
      isRedisAvailable = false;
      logger.warn('[EventConsistency Redis] Error:', err.message || err);
    });
    redis.on('connect', () => logger.info('[EventConsistency Redis] Connected'));
    redis.on('ready', () => {
      isRedisAvailable = true;
      logger.info('[EventConsistency Redis] Ready');
    });
    redis.on('close', () => {
      isRedisAvailable = false;
      logger.warn('[EventConsistency Redis] Closed');
    });
    redis.on('reconnecting', (delay) => logger.warn('[EventConsistency Redis] Reconnecting in', delay, 'ms'));
  } catch (err) {
    logger.warn('[EventConsistency Redis] Failed to initialise - running in degraded mode:', err.message);
    redis = createNoopRedisClient();
    isRedisAvailable = false;
  }
};

initializeRedis();

class EventConsistencyManager {
  constructor() {
    this.eventStream = 'ers-events';
    this.consumerGroup = 'ers-consumers';
  }

  async initializeStream() {
    if (!isRedisAvailable) {
      logger.warn('[EventConsistency] Redis unavailable - skipping stream initialization');
      return;
    }

    try {
      await redis.xinfo('STREAM', this.eventStream);
    } catch (err) {
      try {
        await redis.xgroup('CREATE', this.eventStream, this.consumerGroup, '$', 'MKSTREAM');
        logger.info('Created Redis stream for event consistency');
      } catch (createErr) {
        logger.warn('[EventConsistency] Failed to create stream, continuing without stream support:', createErr.message);
      }
    }
  }

  // Publish event with sequence number
  async publishEvent(event) {
    const eventPayload = {
      type: event.type,
      requestId: event.requestId,
      data: JSON.stringify(event.data),
      timestamp: Date.now(),
      version: event.version || 1,
    };

    if (!isRedisAvailable) {
      logger.warn('[EventConsistency] Redis unavailable - event skipped', { type: event.type, requestId: event.requestId });
      return null;
    }

    try {
      const eventId = await redis.xadd(this.eventStream, '*', ...Object.entries(eventPayload).flat());
      logger.debug('Published event', { type: event.type, eventId });
      return eventId;
    } catch (err) {
      logger.warn('[EventConsistency] Failed to publish event, continuing without event consistency:', err.message);
      return null;
    }
  }

  // Get events for request with strict ordering
  async getRequestEvents(requestId, fromId = '0') {
    if (!isRedisAvailable) {
      return [];
    }

    try {
      const events = await redis.xrange(
        this.eventStream,
        fromId,
        '+',
        'COUNT',
        100
      );

      return events
        .map(([eventId, fields]) => {
          const fieldObj = {};
          for (let i = 0; i < fields.length; i += 2) {
            fieldObj[fields[i]] = fields[i + 1];
          }
          return {
            eventId,
            ...fieldObj,
          };
        })
        .filter((e) => e.requestId === requestId)
        .sort((a, b) => parseInt(a.eventId.split('-')[0], 10) - parseInt(b.eventId.split('-')[0], 10));
    } catch (err) {
      logger.warn('[EventConsistency] Failed to retrieve events, returning empty list:', err.message);
      return [];
    }
  }

  // Prevent stale updates: check if update is newer than last known state
  async isUpdateFresh(requestId, newVersion) {
    if (!isRedisAvailable) {
      return true;
    }

    try {
      const lastVersion = await redis.get(`req:${requestId}:version`);
      return !lastVersion || parseInt(newVersion, 10) > parseInt(lastVersion, 10);
    } catch (err) {
      logger.warn('[EventConsistency] Failed to check update freshness, assuming fresh:', err.message);
      return true; // Optimistic: assume fresh
    }
  }

  // Track latest version for request
  async setLatestVersion(requestId, version) {
    if (!isRedisAvailable) return;

    try {
      await redis.set(`req:${requestId}:version`, version);
    } catch (err) {
      logger.warn('[EventConsistency] Failed to set latest version:', err.message);
    }
  }

  // Get event sequence for audit
  async getEventSequence(requestId) {
    if (!isRedisAvailable) {
      return [];
    }

    const events = await this.getRequestEvents(requestId);
    return events.map((e) => ({
      id: e.eventId,
      type: e.type,
      timestamp: parseInt(e.timestamp, 10),
      version: e.version,
    }));
  }
}

module.exports = new EventConsistencyManager();