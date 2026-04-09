// utils/memoryMonitor.js
'use strict';

/**
 * Memory monitoring and optimization utilities
 */

const logger = require('./logger');

class MemoryMonitor {
  constructor() {
    this.gcInterval = null;
    this.lastGC = Date.now();
    this.gcThreshold = 150 * 1024 * 1024; // 150MB - higher threshold
    this.minGCInterval = 60000; // Minimum 1 minute between GC
  }

  /**
   * Start memory monitoring
   */
  start() {
    if (global.gc && process.env.NODE_ENV === 'production') {
      this.gcInterval = setInterval(() => {
        const memUsage = process.memoryUsage();
        const heapUsed = memUsage.heapUsed;
        const timeSinceLastGC = Date.now() - this.lastGC;

        // Only GC if above threshold AND enough time has passed since last GC
        if (heapUsed > this.gcThreshold && timeSinceLastGC > this.minGCInterval) {
          logger.info('Triggering garbage collection', {
            heapUsed: Math.round(heapUsed / 1024 / 1024) + 'MB',
            heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024) + 'MB',
            timeSinceLastGC: Math.round(timeSinceLastGC / 1000) + 's',
          });

          global.gc();
          this.lastGC = Date.now();
        }
      }, 120000); // Check every 2 minutes instead of 30 seconds
    }
  }

  /**
   * Stop memory monitoring
   */
  stop() {
    if (this.gcInterval) {
      clearInterval(this.gcInterval);
      this.gcInterval = null;
    }
  }

  /**
   * Get memory usage stats
   */
  getStats() {
    const memUsage = process.memoryUsage();
    return {
      heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
      heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
      external: Math.round(memUsage.external / 1024 / 1024),
      rss: Math.round(memUsage.rss / 1024 / 1024),
      lastGC: this.lastGC,
    };
  }

  /**
   * Force cleanup of common memory leaks
   */
  cleanup() {
    // Clear any cached items that might be holding references
    if (global.gc) {
      global.gc();
    }
  }
}

const memoryMonitor = new MemoryMonitor();

module.exports = memoryMonitor;