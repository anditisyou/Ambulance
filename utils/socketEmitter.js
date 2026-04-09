'use strict';

const Redis = require('ioredis');
const logger = require('./logger');

const redisConnection = {
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
};

const publisher = new Redis(redisConnection);

// Batch events to reduce Redis publishes
const eventBuffer = new Map();
const BATCH_INTERVAL = 100; // ms
const MAX_BATCH_SIZE = 10;

setInterval(() => {
  if (eventBuffer.size === 0) return;

  const batch = [];
  for (const [key, events] of eventBuffer) {
    batch.push(...events);
    eventBuffer.delete(key);
  }

  if (batch.length > 0) {
    publisher.publish('socket-events-batch', JSON.stringify(batch)).catch(error => {
      logger.error('Failed to publish batched socket events', { error: error.message });
    });
  }
}, BATCH_INTERVAL);

const emitEvent = async (room, event, data) => {
  try {
    const message = { room, event, data, timestamp: Date.now() };

    // For critical events, send immediately
    if (event.includes('emergency') || event.includes('critical') || event.includes('alert')) {
      await publisher.publish('socket-events', JSON.stringify(message));
      logger.debug('Published critical socket event immediately', { room, event });
      return;
    }

    // For regular events, batch them
    const key = room;
    if (!eventBuffer.has(key)) {
      eventBuffer.set(key, []);
    }

    const roomEvents = eventBuffer.get(key);
    roomEvents.push(message);

    // If batch is full, send immediately
    if (roomEvents.length >= MAX_BATCH_SIZE) {
      await publisher.publish('socket-events-batch', JSON.stringify(roomEvents));
      eventBuffer.delete(key);
      logger.debug('Published full batch of socket events', { room, count: roomEvents.length });
    }

  } catch (error) {
    logger.error('Failed to queue socket event', { error: error.message });
  }
};

module.exports = { emitEvent };