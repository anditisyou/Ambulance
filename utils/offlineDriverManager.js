'use strict';

/**
 * Offline Driver Detection & Recovery System
 * 
 * Handles driver disconnections during active emergencies:
 * - Detects loss of connectivity
 * - Maintains last-known-good location
 * - Auto-reassigns if driver unresponsive
 * - Syncs state when driver reconnects
 */

const redisClient = require('./redisClient');
const EmergencyRequest = require('../models/EmergencyRequest');
const Ambulance = require('../models/Ambulance');
const logger = require('./logger');
const { AuditLogger } = require('../models/AuditLog');
const { addDispatchJob } = require('./dispatchQueue');
const { AMBULANCE_STATUS } = require('./constants');

class OfflineDriverManager {
  constructor() {
    this.config = {
      // Heartbeat timeout (driver must ping every N seconds)
      heartbeatTimeoutMs: 30000,            // 30 seconds
      warningTimeoutMs: 20000,              // Warn at 20 seconds
      autoReassignTimeoutMs: 90000,         // Auto-reassign after 90 seconds offline
      
      // Location retention
      lastKnownLocationRetentionMs: 86400000, // Keep for 24 hours
      
      // Reconnect sync
      maxBacklogEvents: 100,                 // Max events to replay on reconnect
    };

    this.offlineChecks = new Map(); // Track offline timeouts per driver
  }

  /**
   * Record driver heartbeat (driver sends ping)
   */
  async recordHeartbeat(ambulanceId, driverId) {
    try {
      const heartbeatKey = `driver:heartbeat:${ambulanceId}`;
      const timestamp = Date.now();

      // Store heartbeat with TTL
      await redisClient.setex(
        heartbeatKey,
        Math.ceil(this.config.heartbeatTimeoutMs / 1000),
        JSON.stringify({
          driverId: driverId.toString(),
          timestamp,
          online: true,
        })
      );

      // Clear any offline status
      const offlineKey = `driver:offline:${ambulanceId}`;
      await redisClient.del(offlineKey);

      // Clear timeout if exists
      if (this.offlineChecks.has(ambulanceId)) {
        clearTimeout(this.offlineChecks.get(ambulanceId));
        this.offlineChecks.delete(ambulanceId);
      }

      // Schedule next check
      this._scheduleOfflineCheck(ambulanceId, driverId);

      return { online: true };
    } catch (err) {
      logger.error(`Heartbeat recording failed: ${err.message}`);
      return { online: false };
    }
  }

  /**
   * Schedule offline detection check
   */
  _scheduleOfflineCheck(ambulanceId, driverId) {
    // Clear existing timeout
    if (this.offlineChecks.has(ambulanceId)) {
      clearTimeout(this.offlineChecks.get(ambulanceId));
    }

    // Schedule warning check first
    const warningTimeout = setTimeout(() => {
      this._handleOfflineWarning(ambulanceId, driverId);
    }, this.config.warningTimeoutMs);

    // Schedule critical check after
    const criticalTimeout = setTimeout(() => {
      this._handleOfflineDetected(ambulanceId, driverId);
    }, this.config.autoReassignTimeoutMs);

    this.offlineChecks.set(ambulanceId, criticalTimeout);
  }

  /**
   * Handle driver offline warning (still might reconnect)
   */
  async _handleOfflineWarning(ambulanceId, driverId) {
    try {
      const ambulance = await Ambulance.findById(ambulanceId);
      if (!ambulance || ambulance.status !== AMBULANCE_STATUS.EN_ROUTE) return;

      logger.warn(`Driver ${driverId} offline warning for ambulance ${ambulanceId}`);

      // Emit warning to admin dashboard
      const io = global.io; // Assumes io set on global
      if (io) {
        io.to('dispatchers').emit('driver-offline-warning', {
          ambulanceId: ambulanceId.toString(),
          driverId: driverId.toString(),
          timeoutMs: this.config.autoReassignTimeoutMs - this.config.warningTimeoutMs,
        });
      }

      // Store warning in Redis
      const warningKey = `driver:warning:${ambulanceId}`;
      await redisClient.setex(
        warningKey,
        Math.ceil(this.config.autoReassignTimeoutMs / 1000),
        JSON.stringify({ severity: 'WARNING', timestamp: Date.now() })
      );
    } catch (err) {
      logger.error(`Offline warning handling failed: ${err.message}`);
    }
  }

  /**
   * Handle driver detected as offline
   */
  async _handleOfflineDetected(ambulanceId, driverId) {
    try {
      logger.error(`Driver ${driverId} detected OFFLINE for ambulance ${ambulanceId}`);

      // Get current request
      const request = await EmergencyRequest.findOne({
        assignedAmbulanceId: ambulanceId,
        assignmentState: { $in: ['ACCEPTED', 'EN_ROUTE'] },
      });

      if (!request) {
        logger.info(`No active request for offline ambulance ${ambulanceId}`);
        return;
      }

      // Get last known location
      const lastLocationKey = `driver:location:${ambulanceId}`;
      const locationData = await redisClient.get(lastLocationKey);
      const lastLocation = locationData ? JSON.parse(locationData) : null;

      // Mark as offline
      const offlineKey = `driver:offline:${ambulanceId}`;
      await redisClient.setex(
        offlineKey,
        86400, // 24 hours
        JSON.stringify({
          timestamp: Date.now(),
          lastLocation,
          requestId: request._id.toString(),
          driverId: driverId.toString(),
        })
      );

      // Update ambulance status
      const ambulance = await Ambulance.findByIdAndUpdate(
        ambulanceId,
        { status: 'OFFLINE' },
        { new: true }
      );

      // Audit the offline event
      await AuditLogger.log({
        action: 'DRIVER_OFFLINE_AUTODETECTED',
        entity: { id: request._id, type: 'EmergencyRequest' },
        actor: 'SYSTEM',
        changes: {
          before: { assignedAmbulanceId: ambulanceId.toString(), status: 'EN_ROUTE' },
          after: { lastLocation, driverOfflineTime: Date.now() },
        },
        metadata: {
          driverId: driverId.toString(),
          ambulanceId: ambulanceId.toString(),
          lastKnownLocation: lastLocation,
          timeoutMs: this.config.autoReassignTimeoutMs,
        },
      });

      // Try to reassign to another ambulance
      const reassignJob = await addDispatchJob(
        request._id.toString(),
        'reassign',
        ambulanceId.toString(),
        3 // CRITICAL priority
      );

      logger.info(`Reassignment job queued for offline request ${request._id}`);

      // Notify user and hospital
      const io = global.io;
      if (io) {
        io.to(`user_${request.userId}`).emit('ambulance-offline', {
          requestId: request._id.toString(),
          message: 'Previous ambulance lost contact, finding backup...',
          lastLocation,
        });

        io.to(`hospital:tracking:${request.assignedHospital}`).emit('ambulance-offline', {
          ambulanceId: ambulanceId.toString(),
          requestId: request._id.toString(),
          lastLocation,
        });
      }
    } catch (err) {
      logger.error(`Offline detection handling failed: ${err.message}`);
    }
  }

  /**
   * Handle driver reconnection
   */
  async handleDriverReconnect(ambulanceId, driverId) {
    try {
      logger.info(`Driver ${driverId} reconnected for ambulance ${ambulanceId}`);

      // Get offline record
      const offlineKey = `driver:offline:${ambulanceId}`;
      const offlineData = await redisClient.get(offlineKey);

      if (offlineData) {
        const offline = JSON.parse(offlineData);
        const offlineMs = Date.now() - offline.timestamp;

        logger.info(`Driver was offline for ${Math.round(offlineMs / 1000)}s`);

        // If offline < 1 minute, allow resume
        if (offlineMs < 60000) {
          // Clear offline status
          await redisClient.del(offlineKey);

          // Restore ambulance status
          const ambulance = await Ambulance.findByIdAndUpdate(
            ambulanceId,
            { status: AMBULANCE_STATUS.EN_ROUTE },
            { new: true }
          );

          // Get missed events from event stream
          const missedEvents = await this._getMissedEvents(
            offline.requestId,
            offline.timestamp
          );

          // Audit reconnection
          await AuditLogger.log({
            action: 'DRIVER_RECONNECTED',
            entity: { id: offline.requestId, type: 'EmergencyRequest' },
            actor: driverId,
            changes: { offlineDurationMs: offlineMs },
            metadata: {
              missedEventsCount: missedEvents.length,
              status: 'resumed',
            },
          });

          return {
            status: 'RESUMED',
            offlineDurationMs: offlineMs,
            missedEvents,
            currentAssignment: {
              requestId: offline.requestId,
              lastLocation: offline.lastLocation,
            },
          };
        } else {
          // Offline > 1 minute, driver cannot resume
          logger.warn(`Driver offline too long (${Math.round(offlineMs / 1000)}s), reassignment in progress`);

          return {
            status: 'REASSIGNED',
            offlineDurationMs: offlineMs,
            message: 'Your ambulance was reassigned due to extended offline period',
          };
        }
      }

      // Normal reconnect (wasn't marked offline)
      return { status: 'CONNECTED' };
    } catch (err) {
      logger.error(`Reconnect handling failed: ${err.message}`);
      return { status: 'ERROR', error: err.message };
    }
  }

  /**
   * Get events missed during offline period
   */
  async _getMissedEvents(requestId, offlineTimestamp) {
    try {
      // Query Redis streams for events during offline period
      const stream = 'ers-events';
      const events = [];

      // XRANGE finds events in time window
      // This is a simplified approach; for production use XREAD with time filtering
      const missedEvents = await redisClient.evalsha(
        `
        local events = redis.call('XRANGE', 'ers-events', '-', '+')
        local result = {}
        for i, event in ipairs(events) do
          local data = cjson.decode(event[2][2])
          if data.requestId == KEYS[1] and tonumber(event[1]:match('^%d+')) > ARGV[1] then
            table.insert(result, event)
          end
        end
        return result
        `,
        1,
        requestId.toString(),
        offlineTimestamp
      ).catch(() => []);

      return events.slice(0, this.config.maxBacklogEvents);
    } catch (err) {
      logger.error(`Get missed events failed: ${err.message}`);
      return [];
    }
  }

  /**
   * Get offline driver statistics
   */
  async getOfflineStats() {
    try {
      // Count current offline ambulances
      const pattern = 'driver:offline:*';
      const keys = await redisClient.keys(pattern);

      const offlineAmbulances = [];
      for (const key of keys) {
        const data = await redisClient.get(key);
        if (data) {
          offlineAmbulances.push(JSON.parse(data));
        }
      }

      return {
        currentOfflineCount: offlineAmbulances.length,
        offlineAmbulances,
        averageOfflineTimeMs:
          offlineAmbulances.length > 0
            ? offlineAmbulances.reduce((sum, a) => sum + (Date.now() - a.timestamp), 0) /
              offlineAmbulances.length
            : 0,
      };
    } catch (err) {
      logger.error(`Get offline stats failed: ${err.message}`);
      return { error: err.message };
    }
  }

  /**
   * Cleanup (call on process shutdown)
   */
  cleanup() {
    for (const timeout of this.offlineChecks.values()) {
      clearTimeout(timeout);
    }
    this.offlineChecks.clear();
  }
}

module.exports = new OfflineDriverManager();
