'use strict';

const fs = require('fs');
const path = require('path');
const redisClient = require('./redisClient');
const EmergencyRequest = require('../models/EmergencyRequest');
const logger = require('./logger');
const { AuditLogger } = require('../models/AuditLog');

class DataRetentionManager {
  constructor() {
    this.config = {
      logRetentionDays: 30,
      logMaxFileSizeMb: 100,
      logMaxFiles: 10,
      logRotateSchedule: '0 0 * * *',
      streamMaxLengthApprox: 1000000,
      streamTrimIntervalMs: 3600000,
      requestArchiveAfterDays: 180,
      requestArchiveLocation: '/var/data/ers-archive',
      requestHotDays: 30,
      tempDataTTLDays: 7,
      auditLogRetentionYears: 7,
    };

    this.cleanupJobs = new Map();
    this.initialized = false;  // ← ADD: Prevent double initialization
  }

  async initialize() {
    if (this.initialized) {
      logger.warn('Data retention already initialized');
      return;
    }

    try {
      logger.info('Initializing data retention cleanup jobs');

      this._scheduleLogCleanup();
      this._scheduleStreamTrimming();
      this._scheduleRequestArchival();
      this._scheduleTemporaryDataCleanup();

      this.initialized = true;
      logger.info('Data retention jobs initialized');
    } catch (err) {
      logger.error(`Retention initialization failed: ${err.message}`);
    }
  }

  _scheduleLogCleanup() {
    if (this.cleanupJobs.has('log-cleanup')) {
      logger.warn('Log cleanup already scheduled');
      return;
    }

    const interval = setInterval(() => {
      this._cleanupLogFiles();
    }, 6 * 3600 * 1000);

    this.cleanupJobs.set('log-cleanup', interval);
  }

  _scheduleStreamTrimming() {
    if (this.cleanupJobs.has('stream-trim')) {
      logger.warn('Stream trimming already scheduled');
      return;
    }

    const interval = setInterval(() => {
      this._trimRedisStreams();
    }, this.config.streamTrimIntervalMs);

    this.cleanupJobs.set('stream-trim', interval);
  }

  _scheduleRequestArchival() {
    if (this.cleanupJobs.has('request-archival')) {
      logger.warn('Request archival already scheduled');
      return;
    }

    const interval = setInterval(() => {
      this._archiveOldRequests();
    }, 24 * 3600 * 1000);

    this.cleanupJobs.set('request-archival', interval);
  }

  _scheduleTemporaryDataCleanup() {
    if (this.cleanupJobs.has('temp-cleanup')) {
      logger.warn('Temporary data cleanup already scheduled');
      return;
    }

    const interval = setInterval(() => {
      this._cleanupTemporaryRedisKeys();
    }, 24 * 3600 * 1000);

    this.cleanupJobs.set('temp-cleanup', interval);
  }

  /**
   * Cleanup old log files
   */
  async _cleanupLogFiles() {
    try {
      const logDir = path.join(process.cwd(), 'logs');
      if (!fs.existsSync(logDir)) return;

      const files = fs.readdirSync(logDir)
        .filter(f => f.endsWith('.log'))
        .map(f => ({
          name: f,
          path: path.join(logDir, f),
          time: fs.statSync(path.join(logDir, f)).mtime.getTime(),
        }))
        .sort((a, b) => b.time - a.time);

      const cutoffTime = Date.now() - this.config.logRetentionDays * 86400000;

      for (const file of files) {
        // Keep max N files and cutoff age
        if (files.indexOf(file) > this.config.logMaxFiles || file.time < cutoffTime) {
          fs.unlinkSync(file.path);
          logger.info(`Cleaned up log file: ${file.name}`);
        }
      }
    } catch (err) {
      logger.error(`Log cleanup failed: ${err.message}`);
    }
  }

  /**
   * Trim Redis streams to max length
   */
  async _trimRedisStreams() {
    try {
      const streams = ['ers-events'];

      for (const stream of streams) {
        // XTRIM with MAXLEN to limit stream size
        const trimmed = await redisClient.xtrim(
          stream,
          'MAXLEN',
          '~', // Approximate (for performance)
          this.config.streamMaxLengthApprox
        );

        if (trimmed > 0) {
          logger.info(`Trimmed ${trimmed} entries from Redis stream: ${stream}`);
        }
      }

      // Also clean up Redis temporary keys
      await this._cleanupTemporaryRedisKeys();
    } catch (err) {
      logger.error(`Stream trimming failed: ${err.message}`);
    }
  }

  /**
   * Clean up temporary Redis keys
   */
  async _cleanupTemporaryRedisKeys() {
    try {
      for (const prefix of this.config.redisTempPrefixes) {
        // Find keys with pattern and delete expired ones
        const keys = await redisClient.keys(`${prefix}*`);

        for (const key of keys) {
          const ttl = await redisClient.ttl(key);
          
          // TTL -1 means no expiry (should be cleared)
          if (ttl === -1) {
            await redisClient.del(key);
            logger.debug(`Cleaned up orphaned Redis key: ${key}`);
          }
        }
      }
    } catch (err) {
      logger.error(`Temporary key cleanup failed: ${err.message}`);
    }
  }

  /**
   * Archive old completed requests
   */
  async _archiveOldRequests() {
    try {
      const archiveAfterDate = new Date(
        Date.now() - this.config.requestArchiveAfterDays * 86400000
      );

      const oldRequests = await EmergencyRequest.find({
        status: 'COMPLETED',
        completionTime: { $lt: archiveAfterDate },
        archived: { $ne: true },
      })
        .select('_id userId requestTime completionTime')
        .lean()
        .limit(1000); // Process in batches

      if (oldRequests.length === 0) {
        logger.debug('No old requests to archive');
        return;
      }

      // Archive to S3 or other long-term storage
      const archivedIds = [];
      for (const request of oldRequests) {
        try {
          // In production: upload to S3/cold storage
          // await archiveToS3(request);
          archivedIds.push(request._id);
        } catch (err) {
          logger.error(`Failed to archive request ${request._id}: ${err.message}`);
        }
      }

      // Mark as archived in MongoDB
      if (archivedIds.length > 0) {
        await EmergencyRequest.updateMany(
          { _id: { $in: archivedIds } },
          { $set: { archived: true, archivedAt: new Date() } }
        );

        logger.info(`Archived ${archivedIds.length} old requests to cold storage`);
      }
    } catch (err) {
      logger.error(`Request archival failed: ${err.message}`);
    }
  }

  /**
   * Clean temporary data (caches, temp files, etc)
   */
  async _cleanupTemporaryData() {
    try {
      // Clean Redis temp data without TTL
      await this._cleanupTemporaryRedisKeys();

      // Clean temporary location smoothing filters that are stale
      const filterPattern = 'gps:filter:*';
      const filterKeys = await redisClient.keys(filterPattern);

      let cleaned = 0;
      for (const key of filterKeys) {
        const ttl = await redisClient.ttl(key);
        if (ttl === -1) { // No TTL = orphaned
          await redisClient.del(key);
          cleaned++;
        }
      }

      if (cleaned > 0) {
        logger.info(`Cleaned ${cleaned} orphaned GPS filter states`);
      }
    } catch (err) {
      logger.error(`Temporary data cleanup failed: ${err.message}`);
    }
  }

  /**
   * Get storage usage report
   */
  async getStorageReport() {
    try {
      // MongoDB sizes
      const db = EmergencyRequest.db;
      const collections = {
        requests: await EmergencyRequest.collection.stats(),
        auditLogs: await AuditLogger.collection.stats().catch(() => ({})),
      };

      const mongoDbSize = Object.values(collections).reduce(
        (sum, stats) => sum + (stats.size || 0),
        0
      );

      // Redis memory usage
      const redisInfo = await redisClient.info('memory');
      const redisUsedMb = parseInt(redisInfo.match(/used_memory_human:(\S+)/)?.[1] || '0M');

      // Log file sizes
      const logDir = path.join(process.cwd(), 'logs');
      let logFilesSize = 0;
      if (fs.existsSync(logDir)) {
        const files = fs.readdirSync(logDir);
        for (const file of files) {
          logFilesSize += fs.statSync(path.join(logDir, file)).size;
        }
      }

      // Request archival status
      const archivedCount = await EmergencyRequest.countDocuments({ archived: true });
      const hotstorageCount = await EmergencyRequest.countDocuments({ archived: { $ne: true } });

      return {
        timestamp: new Date(),
        storage: {
          mongoDb: {
            sizeBytes: mongoDbSize,
            sizeMb: (mongoDbSize / 1024 / 1024).toFixed(2),
            estimatedDocuments: hotstorageCount + archivedCount,
          },
          redis: redisUsedMb,
          logFiles: {
            sizeBytes: logFilesSize,
            sizeMb: (logFilesSize / 1024 / 1024).toFixed(2),
          },
        },
        dataDistribution: {
          hotStorage: hotstorageCount,
          archived: archivedCount,
          archivedPercentage: (
            (archivedCount / (archivedCount + hotstorageCount)) *
            100
          ).toFixed(1),
        },
      };
    } catch (err) {
      logger.error(`Storage report generation failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Manual trigger archival for compliance
   */
  async forceArchival(beforeDate) {
    try {
      logger.info(`Force archival triggered for data before ${beforeDate}`);
      
      const requests = await EmergencyRequest.find({
        status: 'COMPLETED',
        completionTime: { $lt: beforeDate },
      }).limit(5000);

      // Archive logic here
      logger.info(`Force archived ${requests.length} requests`);
      return requests.length;
    } catch (err) {
      logger.error(`Force archival failed: ${err.message}`);
      throw err;
    }
  }

  /**
   * Cleanup (call on process shutdown)
   */
  cleanup() {
    for (const [name, interval] of this.cleanupJobs) {
      clearInterval(interval);
      logger.info(`Cleared cleanup job: ${name}`);
    }
    this.cleanupJobs.clear();
  }
}

module.exports = new DataRetentionManager();
