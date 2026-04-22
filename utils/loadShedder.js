'use strict';

const logger = require('./logger');

/**
 * Load Shedding Strategy
 * Rejects/defers low-priority requests under extreme load
 */

class LoadShedder {
  constructor() {
    this.thresholds = {
      // Queue length thresholds
      moderate: 50,
      high: 100,
      critical: 200,
      // Ambulance utilization
      maxUtilization: 0.95,
    };

    this.shedStrategy = {
      moderate: { LOW: 0.2, MEDIUM: 0 }, // Shed 20% of LOW priority
      high: { LOW: 0.5, MEDIUM: 0.1 }, // Shed 50% LOW, 10% MEDIUM
      critical: { LOW: 1.0, MEDIUM: 0.5, HIGH: 0.1 }, // Shed all LOW, 50% MEDIUM, 10% HIGH
    };

    this.shedStatus = 'NORMAL'; // NORMAL, MODERATE, HIGH, CRITICAL
  }

  updateStatus(metrics) {
    const queueLength = metrics.waiting || 0;
    const utilization = metrics.allocations > 0 
      ? (metrics.allocations / (metrics.allocations + metrics.rejections)) 
      : 0;

    if (queueLength > this.thresholds.critical || utilization > this.thresholds.maxUtilization) {
      this.shedStatus = 'CRITICAL';
    } else if (queueLength > this.thresholds.high) {
      this.shedStatus = 'HIGH';
    } else if (queueLength > this.thresholds.moderate) {
      this.shedStatus = 'MODERATE';
    } else {
      this.shedStatus = 'NORMAL';
    }

    return this.shedStatus;
  }

  shouldShedRequest(priority) {
    if (this.shedStatus === 'NORMAL') return false;

    const strategy = this.shedStrategy[this.shedStatus.toLowerCase()];
    const shedProbability = strategy[priority] || 0;
    const shouldShed = Math.random() < shedProbability;

    if (shouldShed) {
      logger.warn('Request shedded', {
        priority,
        shedStatus: this.shedStatus,
        shedProbability,
      });
    }

    return shouldShed;
  }

  getBackoffTime() {
    const backoffMap = {
      NORMAL: 0,
      MODERATE: 1000,
      HIGH: 5000,
      CRITICAL: 30000,
    };
    return backoffMap[this.shedStatus];
  }

  getStatus() {
    return this.shedStatus;
  }
}

module.exports = LoadShedder;