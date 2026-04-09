'use strict';

const logger = require('./logger');
const AlertManager = require('./alerting');

const alertManager = new AlertManager();

// Simple in-memory metrics (in production, use Prometheus)
const metrics = {
  requests: 0,
  errors: 0,
  allocations: 0,
  rejections: 0,
  avgResponseTime: 0,
  responseTimes: [],
  dispatchSuccess: 0,
  dispatchFailure: 0,
  dispatchRetries: 0,
  dispatchQueueDepth: 0,
  queueWaiting: 0,
  queueActive: 0,
  queueDelayed: 0,
  queueFailed: 0,
  queueCompleted: 0,
  stuckRequests: 0,
};

const recordRequest = (method, path, status, responseTime) => {
  metrics.requests++;
  if (status >= 400) metrics.errors++;

  metrics.responseTimes.push(responseTime);
  if (metrics.responseTimes.length > 100) metrics.responseTimes.shift();
  metrics.avgResponseTime = metrics.responseTimes.reduce((a, b) => a + b, 0) / metrics.responseTimes.length;

  logger.info('Request metrics', {
    method,
    path,
    status,
    responseTime,
    totalRequests: metrics.requests,
    errorRate: (metrics.errors / metrics.requests * 100).toFixed(2) + '%',
    avgResponseTime: metrics.avgResponseTime.toFixed(2) + 'ms',
  });

  // Check for alerts
  alertManager.checkThresholds(metrics);
};

const recordAllocation = () => {
  metrics.allocations++;
};

const recordRejection = () => {
  metrics.rejections++;
};

const recordDispatchSuccess = () => {
  metrics.dispatchSuccess++;
};

const recordDispatchFailure = () => {
  metrics.dispatchFailure++;
};

const recordDispatchRetry = () => {
  metrics.dispatchRetries++;
};

const setDispatchQueueStats = ({ waiting, active, delayed, failed, completed }) => {
  metrics.queueWaiting = waiting;
  metrics.queueActive = active;
  metrics.queueDelayed = delayed;
  metrics.queueFailed = failed;
  metrics.queueCompleted = completed;
  metrics.dispatchQueueDepth = waiting + active + delayed;
};

const recordStuckRequests = (count) => {
  metrics.stuckRequests = count;
};

const setDispatchQueueDepth = (depth) => {
  metrics.dispatchQueueDepth = depth;
};

const getMetrics = () => ({ ...metrics });

const getPrometheusMetrics = () => alertManager.exportMetrics(metrics);

module.exports = {
  recordRequest,
  recordAllocation,
  recordRejection,
  recordDispatchSuccess,
  recordDispatchFailure,
  recordDispatchRetry,
  setDispatchQueueStats,
  setDispatchQueueDepth,
  recordStuckRequests,
  getMetrics,
  getPrometheusMetrics,
};