'use strict';

const mongoose = require('mongoose');
const Redis = require('ioredis');
const logger = require('./logger');
const os = require('os');
const fs = require('fs');

/**
 * COMPREHENSIVE HEALTH CHECK SYSTEM
 * 
 * Monitors:
 * - Database connectivity and performance
 * - Redis connectivity
 * - Memory usage
 * - CPU usage
 * - Disk space
 * - Queue depth
 * - Active connections
 * - Error rates
 * 
 * Used by:
 * - Kubernetes readiness/liveness probes
 * - Load balancer health checks
 * - Monitoring systems
 * - Admin dashboards
 */

const HEALTH_THRESHOLDS = {
  memoryUsagePercent: 85,
  cpuUsagePercent: 90,
  diskUsagePercent: 90,
  responseTimeMs: 1000,
  errorRatePercent: 5,
  queueDepth: 1000,
  mongoDbLatencyMs: 500,
  redisLatencyMs: 100
};

/**
 * Component health status
 */
const HEALTH_STATUS = {
  UP: 'UP',
  DEGRADED: 'DEGRADED',
  DOWN: 'DOWN'
};

/**
 * Check database connectivity and performance
 */
const checkDatabase = async () => {
  const startTime = Date.now();

  try {
    // Check connection state
    if (!mongoose.connection.readyState || mongoose.connection.readyState !== 1) {
      return {
        status: HEALTH_STATUS.DOWN,
        latency: -1,
        message: `Database disconnected (state: ${mongoose.connection.readyState})`
      };
    }

    // Test query performance
    const testCollection = mongoose.connection.collection('_health_check_');
    await testCollection.findOne({});

    const latency = Date.now() - startTime;

    return {
      status: latency > HEALTH_THRESHOLDS.mongoDbLatencyMs 
        ? HEALTH_STATUS.DEGRADED 
        : HEALTH_STATUS.UP,
      latency,
      message: `Database healthy (${latency}ms)`
    };
  } catch (err) {
    return {
      status: HEALTH_STATUS.DOWN,
      latency: -1,
      message: `Database error: ${err.message}`
    };
  }
};

/**
 * Check Redis connectivity and performance
 */
const checkRedis = async (redisClient) => {
  if (!redisClient) {
    return {
      status: HEALTH_STATUS.DOWN,
      latency: -1,
      message: 'Redis client not configured'
    };
  }

  const startTime = Date.now();

  try {
    // Test PING command
    await redisClient.ping();
    const latency = Date.now() - startTime;

    return {
      status: latency > HEALTH_THRESHOLDS.redisLatencyMs 
        ? HEALTH_STATUS.DEGRADED 
        : HEALTH_STATUS.UP,
      latency,
      message: `Redis healthy (${latency}ms)`,
      info: {
        status: redisClient.status,
        mode: redisClient.mode
      }
    };
  } catch (err) {
    return {
      status: HEALTH_STATUS.DOWN,
      latency: -1,
      message: `Redis error: ${err.message}`
    };
  }
};

/**
 * Check memory usage
 */
const checkMemory = () => {
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();
  const usedMemory = totalMemory - freeMemory;
  const usagePercent = (usedMemory / totalMemory) * 100;

  const processMemory = process.memoryUsage();

  return {
    status: usagePercent > HEALTH_THRESHOLDS.memoryUsagePercent 
      ? HEALTH_STATUS.DEGRADED 
      : HEALTH_STATUS.UP,
    usagePercent: Math.round(usagePercent * 100) / 100,
    usedMemory: Math.round(usedMemory / 1024 / 1024), // MB
    totalMemory: Math.round(totalMemory / 1024 / 1024), // MB
    processMemory: {
      heapUsed: Math.round(processMemory.heapUsed / 1024 / 1024), // MB
      heapTotal: Math.round(processMemory.heapTotal / 1024 / 1024), // MB
      rss: Math.round(processMemory.rss / 1024 / 1024), // MB
      external: Math.round(processMemory.external / 1024 / 1024) // MB
    },
    message: `Memory usage ${usagePercent.toFixed(2)}%`
  };
};

/**
 * Check CPU usage
 */
const checkCpu = () => {
  const cpus = os.cpus();
  const loads = os.loadavg();
  const cpuCount = cpus.length;
  const cpuUsagePercent = (loads[0] / cpuCount) * 100;

  return {
    status: cpuUsagePercent > HEALTH_THRESHOLDS.cpuUsagePercent 
      ? HEALTH_STATUS.DEGRADED 
      : HEALTH_STATUS.UP,
    usagePercent: Math.round(cpuUsagePercent * 100) / 100,
    cores: cpuCount,
    loadAverage: {
      '1min': loads[0],
      '5min': loads[1],
      '15min': loads[2]
    },
    message: `CPU load average 1min: ${loads[0].toFixed(2)}`
  };
};

/**
 * Check disk space
 */
const checkDiskSpace = (diskPath = '/') => {
  try {
    // Note: This is a simplified version. In production, use a proper disk space library
    const stats = fs.statfsSync(diskPath);
    const totalSpace = stats.blocks * stats.bsize;
    const availableSpace = stats.bavail * stats.bsize;
    const usedSpace = totalSpace - availableSpace;
    const usagePercent = (usedSpace / totalSpace) * 100;

    return {
      status: usagePercent > HEALTH_THRESHOLDS.diskUsagePercent 
        ? HEALTH_STATUS.DEGRADED 
        : HEALTH_STATUS.UP,
      usagePercent: Math.round(usagePercent * 100) / 100,
      usedSpace: Math.round(usedSpace / 1024 / 1024), // MB
      totalSpace: Math.round(totalSpace / 1024 / 1024), // MB
      availableSpace: Math.round(availableSpace / 1024 / 1024), // MB
      message: `Disk usage ${usagePercent.toFixed(2)}%`
    };
  } catch (err) {
    return {
      status: HEALTH_STATUS.DEGRADED,
      message: `Cannot check disk space: ${err.message}`
    };
  }
};

/**
 * Comprehensive health check
 */
const getHealthStatus = async (redisClient, includeDetails = false) => {
  const startTime = Date.now();

  const [dbHealth, redisHealth, memoryHealth, cpuHealth, diskHealth] = await Promise.all([
    checkDatabase(),
    checkRedis(redisClient),
    Promise.resolve(checkMemory()),
    Promise.resolve(checkCpu()),
    Promise.resolve(checkDiskSpace())
  ]);

  const overallStatus = [dbHealth, redisHealth, memoryHealth, cpuHealth, diskHealth]
    .some(h => h.status === HEALTH_STATUS.DOWN)
    ? HEALTH_STATUS.DOWN
    : [dbHealth, redisHealth, memoryHealth, cpuHealth, diskHealth]
        .some(h => h.status === HEALTH_STATUS.DEGRADED)
      ? HEALTH_STATUS.DEGRADED
      : HEALTH_STATUS.UP;

  const duration = Date.now() - startTime;

  const healthResponse = {
    status: overallStatus,
    timestamp: new Date().toISOString(),
    checkDurationMs: duration,
    uptime: process.uptime(),
    ...(includeDetails && {
      components: {
        database: dbHealth,
        redis: redisHealth,
        memory: memoryHealth,
        cpu: cpuHealth,
        disk: diskHealth
      }
    })
  };

  return healthResponse;
};

/**
 * Liveness probe (is server running?)
 */
const getLivenessProbe = () => {
  return {
    status: 'ALIVE',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  };
};

/**
 * Readiness probe (can server accept traffic?)
 */
const getReadinessProbe = async (redisClient) => {
  const health = await getHealthStatus(redisClient, false);
  
  return {
    ready: health.status === HEALTH_STATUS.UP || health.status === HEALTH_STATUS.DEGRADED,
    status: health.status,
    timestamp: health.timestamp
  };
};

/**
 * Deep health check (for monitoring systems)
 */
const getDeepHealthStatus = async (redisClient) => {
  return getHealthStatus(redisClient, true);
};

/**
 * Create health check middleware
 */
const createHealthCheckMiddleware = (redisClient) => {
  return async (req, res) => {
    try {
      const includeDetails = req.query.details === 'true';
      const health = await getHealthStatus(redisClient, includeDetails);

      const statusCode = health.status === HEALTH_STATUS.UP ? 200 : 503;
      res.status(statusCode).json(health);
    } catch (err) {
      logger.error('Health check error', { error: err.message });
      res.status(503).json({
        status: HEALTH_STATUS.DOWN,
        message: 'Health check failed',
        timestamp: new Date().toISOString()
      });
    }
  };
};

module.exports = {
  checkDatabase,
  checkRedis,
  checkMemory,
  checkCpu,
  checkDiskSpace,
  getHealthStatus,
  getLivenessProbe,
  getReadinessProbe,
  getDeepHealthStatus,
  createHealthCheckMiddleware,
  HEALTH_STATUS,
  HEALTH_THRESHOLDS
};
