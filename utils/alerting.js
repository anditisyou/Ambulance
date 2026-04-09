'use strict';

const logger = require('./logger');
const notificationService = require('./notificationService');

class AlertManager {
  constructor() {
    this.alerts = [];
    this.thresholds = {
      queueSize: parseInt(process.env.QUEUE_OVERFLOW_THRESHOLD, 10) || 100,
      errorRate: parseFloat(process.env.FAILURE_RATE_THRESHOLD) || 0.05, // 5%
      responseTime: parseInt(process.env.RESPONSE_TIME_THRESHOLD_MS, 10) || 5000, // 5 seconds
      stuckRequests: parseInt(process.env.STUCK_REQUEST_THRESHOLD, 10) || 5,
      dispatchFailureRate: parseFloat(process.env.DISPATCH_FAILURE_RATE_THRESHOLD) || 0.10,
    };
    this.alertCooldowns = new Map(); // Prevent alert spam
  }

  checkThresholds(metrics) {
    const alerts = [];
    const totalDispatches = metrics.dispatchSuccess + metrics.dispatchFailure;
    const now = Date.now();
    const cooldownMs = 5 * 60 * 1000; // 5 minutes cooldown

    if (metrics.queueWaiting > this.thresholds.queueSize || metrics.dispatchQueueDepth > this.thresholds.queueSize) {
      const alertKey = 'queue_overflow';
      if (!this.alertCooldowns.has(alertKey) || now - this.alertCooldowns.get(alertKey) > cooldownMs) {
        alerts.push({
          type: alertKey,
          severity: 'warning',
          message: `Dispatch queue size ${metrics.dispatchQueueDepth} exceeds threshold ${this.thresholds.queueSize}`,
          value: metrics.dispatchQueueDepth,
        });
        this.alertCooldowns.set(alertKey, now);
      }
    }

    if (metrics.requests > 0 && (metrics.errors / metrics.requests) > this.thresholds.errorRate) {
      const alertKey = 'error_rate';
      if (!this.alertCooldowns.has(alertKey) || now - this.alertCooldowns.get(alertKey) > cooldownMs) {
        alerts.push({
          type: alertKey,
          severity: 'error',
          message: `API error rate ${(metrics.errors / metrics.requests * 100).toFixed(2)}% exceeds threshold ${this.thresholds.errorRate * 100}%`,
          value: metrics.errors / metrics.requests,
        });
        this.alertCooldowns.set(alertKey, now);
      }
    }

    if (totalDispatches > 0 && (metrics.dispatchFailure / totalDispatches) > this.thresholds.dispatchFailureRate) {
      const alertKey = 'dispatch_failure_rate';
      if (!this.alertCooldowns.has(alertKey) || now - this.alertCooldowns.get(alertKey) > cooldownMs) {
        alerts.push({
          type: alertKey,
          severity: 'error',
          message: `Dispatch failure rate ${(metrics.dispatchFailure / totalDispatches * 100).toFixed(2)}% exceeds threshold ${(this.thresholds.dispatchFailureRate * 100).toFixed(2)}%`,
          value: metrics.dispatchFailure / totalDispatches,
        });
        this.alertCooldowns.set(alertKey, now);
      }
    }

    if (metrics.stuckRequests > this.thresholds.stuckRequests) {
      const alertKey = 'stuck_requests';
      if (!this.alertCooldowns.has(alertKey) || now - this.alertCooldowns.get(alertKey) > cooldownMs) {
        alerts.push({
          type: alertKey,
          severity: 'warning',
          message: `Stuck requests count ${metrics.stuckRequests} exceeds threshold ${this.thresholds.stuckRequests}`,
          value: metrics.stuckRequests,
        });
        this.alertCooldowns.set(alertKey, now);
      }
    }

    if (metrics.avgResponseTime > this.thresholds.responseTime) {
      const alertKey = 'response_time';
      if (!this.alertCooldowns.has(alertKey) || now - this.alertCooldowns.get(alertKey) > cooldownMs) {
        alerts.push({
          type: alertKey,
          severity: 'warning',
          message: `Average response time ${metrics.avgResponseTime.toFixed(2)}ms exceeds threshold ${this.thresholds.responseTime}ms`,
          value: metrics.avgResponseTime,
        });
        this.alertCooldowns.set(alertKey, now);
      }
    }

    // Send alerts via notification service
    alerts.forEach(async (alert) => {
      logger.error('ALERT', alert);
      try {
        await notificationService.sendAlert(alert);
      } catch (error) {
        logger.error('Failed to send alert notification:', error);
      }
    });

    return alerts;
  }

  // Prometheus-style metrics export
  exportMetrics(metrics) {
    return `
# HELP ers_requests_total Total number of requests
# TYPE ers_requests_total counter
ers_requests_total ${metrics.requests}

# HELP ers_errors_total Total number of errors
# TYPE ers_errors_total counter
ers_errors_total ${metrics.errors}

# HELP ers_allocations_total Total number of allocations
# TYPE ers_allocations_total counter
ers_allocations_total ${metrics.allocations}

# HELP ers_rejections_total Total number of rejections
# TYPE ers_rejections_total counter
ers_rejections_total ${metrics.rejections}

# HELP ers_dispatch_success_total Total successful dispatch jobs
# TYPE ers_dispatch_success_total counter
ers_dispatch_success_total ${metrics.dispatchSuccess}

# HELP ers_dispatch_failure_total Total failed dispatch jobs
# TYPE ers_dispatch_failure_total counter
ers_dispatch_failure_total ${metrics.dispatchFailure}

# HELP ers_dispatch_retries_total Total dispatch retries
# TYPE ers_dispatch_retries_total counter
ers_dispatch_retries_total ${metrics.dispatchRetries}

# HELP ers_queue_waiting Number of jobs waiting in queue
# TYPE ers_queue_waiting gauge
ers_queue_waiting ${metrics.queueWaiting || 0}

# HELP ers_queue_active Number of active jobs in queue
# TYPE ers_queue_active gauge
ers_queue_active ${metrics.queueActive || 0}

# HELP ers_queue_delayed Number of delayed jobs in queue
# TYPE ers_queue_delayed gauge
ers_queue_delayed ${metrics.queueDelayed || 0}

# HELP ers_queue_failed Number of failed jobs in queue
# TYPE ers_queue_failed gauge
ers_queue_failed ${metrics.queueFailed || 0}

# HELP ers_dispatch_queue_depth Total queue depth
# TYPE ers_dispatch_queue_depth gauge
ers_dispatch_queue_depth ${metrics.dispatchQueueDepth || 0}

# HELP ers_stuck_requests Number of stuck requests detected
# TYPE ers_stuck_requests gauge
ers_stuck_requests ${metrics.stuckRequests || 0}
    `.trim();
  }
}

module.exports = AlertManager;