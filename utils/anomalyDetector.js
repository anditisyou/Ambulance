'use strict';

/**
 * Fraud & Misuse Detection System
 * 
 * Detects malicious or erroneous patterns:
 * - Multiple rapid requests from same user (spam)
 * - Repeated cancellations (wasting resources)
 * - Impossible travel speeds (GPS spoofing?)
 * - Fake emergency patterns (testing abuse)
 * - Cross-request anomalies (unusual behavior)
 */

const redisClient = require('./redisClient');
const logger = require('./logger');
const { AuditLogger } = require('../models/AuditLog');

class AnomalyDetector {
  constructor() {
    this.config = {
      // Request spam detection
      maxRequestsPerHour: 3,         // Max legitimate requests per user per hour
      maxRequestsPerDay: 10,         // Max per day
      flagThreshold: 0.75,           // Flag if usage > 75% of limit
      
      // Cancellation abuse
      maxCancellationsPerDay: 5,     // Max cancellations before flag
      maxRejectionsByDriver: 3,      // Driver rejecting >3 in a row = suspicious
      
      // Geographic anomalies
      maxTravelSpeedKmh: 300,        // No ambulance should travel >300km/h
      minTravelSpeedKmh: 1,          // Should move at least 1km/h when en-route
      
      // Time anomalies
      maxAcceptanceTimeMs: 120000,   // > 2 min acceptance = suspicious
      minCompletionTimeMs: 300000,   // < 5 min completion too fast = suspicious (fake)
    };

    this.blockDurationMs = 15 * 60 * 1000; // Block for 15 minutes
  }

  /**
   * Check all anomalies for a request
   */
  async detectAnomalies(userId, requestData, previousBehavior) {
    const detections = [];

    // 1. Check request spam
    const spamCheck = await this._checkRequestSpam(userId);
    if (spamCheck.anomaly) detections.push(spamCheck);

    // 2. Check cancellation/rejection patterns
    if (previousBehavior?.recentRejections) {
      const rejectionCheck = this._checkRejectionPattern(previousBehavior.recentRejections);
      if (rejectionCheck.anomaly) detections.push(rejectionCheck);
    }

    // 3. Check for repeated cancellations
    const cancellationCheck = await this._checkCancellationAbuse(userId);
    if (cancellationCheck.anomaly) detections.push(cancellationCheck);

    // 4. Geographic sanity check
    if (previousBehavior?.lastLocation && requestData?.location) {
      const geoCheck = this._checkGeographicAnomalies(
        previousBehavior.lastLocation,
        requestData.location,
        previousBehavior.lastRequestTime
      );
      if (geoCheck.anomaly) detections.push(geoCheck);
    }

    return {
      riskScore: this._calculateRiskScore(detections),
      detections,
      action: this._determineAction(detections),
    };
  }

  /**
   * Check for request spam (rapid-fire requests from same user)
   */
  async _checkRequestSpam(userId) {
    try {
      const hourKey = `user:requests:hourly:${userId}:${Math.floor(Date.now() / 3600000)}`;
      const dayKey = `user:requests:daily:${userId}:${Math.floor(Date.now() / 86400000)}`;

      const hourlyCount = await redisClient.incr(hourKey);
      const dailyCount = await redisClient.incr(dayKey);

      // Set TTL on first increment
      if (hourlyCount === 1) await redisClient.expire(hourKey, 3600);
      if (dailyCount === 1) await redisClient.expire(dayKey, 86400);

      if (hourlyCount > this.config.maxRequestsPerHour) {
        return {
          anomaly: true,
          type: 'REQUEST_SPAM_HOURLY',
          severity: 'HIGH',
          message: `${hourlyCount} requests in past hour (limit: ${this.config.maxRequestsPerHour})`,
          count: hourlyCount,
          threshold: this.config.maxRequestsPerHour,
        };
      }

      if (dailyCount > this.config.maxRequestsPerDay) {
        return {
          anomaly: true,
          type: 'REQUEST_SPAM_DAILY',
          severity: 'HIGH',
          message: `${dailyCount} requests in past day (limit: ${this.config.maxRequestsPerDay})`,
          count: dailyCount,
          threshold: this.config.maxRequestsPerDay,
        };
      }

      // Flag if approaching limits (75%)
      if (hourlyCount > this.config.maxRequestsPerHour * this.config.flagThreshold) {
        return {
          anomaly: false,
          type: 'REQUEST_SPAM_WARNING',
          severity: 'MEDIUM',
          message: `Approaching hourly limit: ${hourlyCount}/${this.config.maxRequestsPerHour}`,
          count: hourlyCount,
        };
      }

      return { anomaly: false };
    } catch (err) {
      logger.error(`Request spam check failed: ${err.message}`);
      return { anomaly: false }; // Fail open
    }
  }

  /**
   * Check rejection pattern (driver rejecting unusually many requests)
   */
  _checkRejectionPattern(recentRejections) {
    if (!Array.isArray(recentRejections)) return { anomaly: false };

    // Count rejections in last hour
    const oneHourAgo = Date.now() - 3600000;
    const recentRejects = recentRejections.filter(r => r.timestamp > oneHourAgo);

    if (recentRejects.length > this.config.maxRejectionsByDriver) {
      return {
        anomaly: true,
        type: 'DRIVER_REJECTION_ABUSE',
        severity: 'MEDIUM',
        message: `Driver rejected ${recentRejects.length} requests in past hour`,
        count: recentRejects.length,
        threshold: this.config.maxRejectionsByDriver,
      };
    }

    return { anomaly: false };
  }

  /**
   * Check for repeated cancellations (wasting ambulance resources)
   */
  async _checkCancellationAbuse(userId) {
    try {
      const dayKey = `user:cancellations:${userId}:${Math.floor(Date.now() / 86400000)}`;
      const count = await redisClient.get(dayKey);
      const cancelCount = parseInt(count || 0);

      if (cancelCount > this.config.maxCancellationsPerDay) {
        return {
          anomaly: true,
          type: 'CANCELLATION_ABUSE',
          severity: 'MEDIUM',
          message: `${cancelCount} cancellations today (limit: ${this.config.maxCancellationsPerDay})`,
          count: cancelCount,
          threshold: this.config.maxCancellationsPerDay,
        };
      }

      return { anomaly: false };
    } catch (err) {
      logger.error(`Cancellation check failed: ${err.message}`);
      return { anomaly: false };
    }
  }

  /**
   * Detect impossible geography (GPS spoofing or data corruption)
   */
  _checkGeographicAnomalies(lastLocation, currentLocation, lastRequestTime) {
    try {
      const lat1 = lastLocation.coordinates?.[1] || 0;
      const lon1 = lastLocation.coordinates?.[0] || 0;
      const lat2 = currentLocation.coordinates?.[1] || 0;
      const lon2 = currentLocation.coordinates?.[0] || 0;

      // Haversine distance calculation
      const R = 6371; // Earth radius in km
      const dLat = ((lat2 - lat1) * Math.PI) / 180;
      const dLon = ((lon2 - lon1) * Math.PI) / 180;
      const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos((lat1 * Math.PI) / 180) *
          Math.cos((lat2 * Math.PI) / 180) *
          Math.sin(dLon / 2) *
          Math.sin(dLon / 2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      const distanceKm = R * c;

      // Time elapsed in hours
      const timeHours = (Date.now() - lastRequestTime) / 3600000;

      if (timeHours > 0) {
        const speedKmh = distanceKm / timeHours;

        if (speedKmh > this.config.maxTravelSpeedKmh) {
          return {
            anomaly: true,
            type: 'IMPOSSIBLE_TRAVEL_SPEED',
            severity: 'HIGH',
            message: `Travel speed ${speedKmh.toFixed(1)} km/h exceeds max ${this.config.maxTravelSpeedKmh} km/h`,
            speedKmh: speedKmh.toFixed(1),
            distanceKm: distanceKm.toFixed(2),
            timeHours: timeHours.toFixed(2),
          };
        }
      }

      return { anomaly: false };
    } catch (err) {
      logger.error(`Geographic check failed: ${err.message}`);
      return { anomaly: false };
    }
  }

  /**
   * Check completion time for fake emergencies
   */
  _checkCompletionTimeAnomaly(requestTime, completionTime) {
    const durationMs = completionTime - requestTime;

    if (durationMs < this.config.minCompletionTimeMs) {
      return {
        anomaly: true,
        type: 'FAKE_EMERGENCY_PATTERN',
        severity: 'MEDIUM',
        message: `Request completed in ${(durationMs / 1000).toFixed(0)}s (unusually fast)`,
        durationSeconds: Math.round(durationMs / 1000),
        threshold: Math.round(this.config.minCompletionTimeMs / 1000),
      };
    }

    return { anomaly: false };
  }

  /**
   * Calculate composite risk score 0-100
   */
  _calculateRiskScore(detections) {
    if (!Array.isArray(detections) || detections.length === 0) return 0;

    const severityScores = {
      LOW: 10,
      MEDIUM: 30,
      HIGH: 60,
    };

    const scores = detections
      .filter(d => d.severity)
      .map(d => severityScores[d.severity] || 0);

    return Math.min(100, Math.ceil(scores.reduce((a, b) => a + b, 0) / scores.length));
  }

  /**
   * Determine action based on detections
   */
  _determineAction(detections) {
    const highSeverity = detections.some(d => d.severity === 'HIGH');
    const mediumSeverity = detections.some(d => d.severity === 'MEDIUM');

    if (highSeverity) {
      return {
        action: 'BLOCK',
        reason: 'High-severity anomaly detected',
        blockDurationMs: this.blockDurationMs,
        requiresReview: true,
      };
    }

    if (mediumSeverity) {
      return {
        action: 'FLAG_AND_MONITOR',
        reason: 'Medium-severity anomaly detected',
        notifyAdmin: true,
        capRequests: true,
      };
    }

    return { action: 'ALLOW' };
  }

  /**
   * Check if user is blocked
   */
  async isUserBlocked(userId) {
    try {
      const blockKey = `user:blocked:${userId}`;
      const blocked = await redisClient.get(blockKey);
      return !!blocked;
    } catch (err) {
      logger.error(`Block check failed: ${err.message}`);
      return false;
    }
  }

  /**
   * Temporarily block user
   */
  async blockUser(userId, reason, durationMs = this.blockDurationMs) {
    try {
      const blockKey = `user:blocked:${userId}`;
      await redisClient.setex(blockKey, Math.ceil(durationMs / 1000), JSON.stringify({ reason, blockedAt: Date.now() }));

      // Audit log the block
      await AuditLogger.log({
        action: 'USER_BLOCKED',
        entity: { id: userId, type: 'User' },
        actor: 'SYSTEM',
        changes: { reason },
        metadata: { durationMs, blockReason: reason },
      });

      logger.warn(`User ${userId} blocked for ${durationMs}ms: ${reason}`);
    } catch (err) {
      logger.error(`Block user failed: ${err.message}`);
    }
  }

  /**
   * Track cancellation for user
   */
  async trackCancellation(userId) {
    try {
      const dayKey = `user:cancellations:${userId}:${Math.floor(Date.now() / 86400000)}`;
      const count = await redisClient.incr(dayKey);
      if (count === 1) await redisClient.expire(dayKey, 86400);
    } catch (err) {
      logger.error(`Cancel tracking failed: ${err.message}`);
    }
  }

  /**
   * Export anomaly statistics for admin dashboard
   */
  async getAnomalyStats(timeWindowMinutes = 60) {
    try {
      // This would query audit logs for detected anomalies
      // For now, return structure
      return {
        timeWindow: timeWindowMinutes,
        totalDetections: 0,
        byType: {},
        blockedUsers: 0,
        flaggedForReview: 0,
      };
    } catch (err) {
      logger.error(`Get anomaly stats failed: ${err.message}`);
      return null;
    }
  }
}

module.exports = new AnomalyDetector();
