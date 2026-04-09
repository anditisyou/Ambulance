'use strict';

const Redis = require('ioredis');
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

const redis = new Redis(redisConnection, {
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

redis.on('error', (err) => logger.warn('[EventConsistency Redis] Error:', err.message || err));
redis.on('connect', () => logger.info('[EventConsistency Redis] Connected'));
redis.on('ready', () => logger.info('[EventConsistency Redis] Ready'));
redis.on('close', () => logger.warn('[EventConsistency Redis] Closed'));
redis.on('reconnecting', (delay) => logger.warn('[EventConsistency Redis] Reconnecting in', delay, 'ms'));

class EventConsistencyManager {
  constructor() {
    this.eventStream = 'ers-events';
    this.consumerGroup = 'ers-consumers';
  }

  async initializeStream() {
    try {
      await redis.xinfo('STREAM', this.eventStream);
    } catch (err) {
      // Stream doesn't exist, create it
      await redis.xgroup('CREATE', this.eventStream, this.consumerGroup, '$', 'MKSTREAM');
      logger.info('Created Redis stream for event consistency');
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

    try {
      const eventId = await redis.xadd(this.eventStream, '*', ...Object.entries(eventPayload).flat());
      logger.debug('Published event', { type: event.type, eventId });
      return eventId;
    } catch (err) {
      logger.error('Failed to publish event', err.message);
      throw err;
    }
  }

  // Get events for request with strict ordering
  async getRequestEvents(requestId, fromId = '0') {
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
        .filter(e => e.requestId === requestId)
        .sort((a, b) => parseInt(a.eventId.split('-')[0]) - parseInt(b.eventId.split('-')[0]));
    } catch (err) {
      logger.error('Failed to retrieve events', err.message);
      return [];
    }
  }

  // Prevent stale updates: check if update is newer than last known state
  async isUpdateFresh(requestId, newVersion) {
    try {
      const lastVersion = await redis.get(`req:${requestId}:version`);
      return !lastVersion || parseInt(newVersion) > parseInt(lastVersion);
    } catch (err) {
      logger.error('Failed to check update freshness', err.message);
      return true; // Optimistic: assume fresh
    }
  }

  // Track latest version for request
  async setLatestVersion(requestId, version) {
    try {
      await redis.set(`req:${requestId}:version`, version);
    } catch (err) {
      logger.error('Failed to set latest version', err.message);
    }
  }

  // Get event sequence for audit
  async getEventSequence(requestId) {
    const events = await this.getRequestEvents(requestId);
    return events.map(e => ({
      id: e.eventId,
      type: e.type,
      timestamp: parseInt(e.timestamp),
      version: e.version,
    }));
  }
}

module.exports = new EventConsistencyManager();