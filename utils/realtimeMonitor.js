'use strict';

/**
 * Real-Time System Monitoring Utility
 * 
 * Tracks system-wide metrics:
 * - Active ambulances and their status
 * - Pending/assigned/in-transit requests
 * - Hospital capacity and bed availability
 * - Queue depth and throughput
 * - Real-time ETA and dispatch performance
 * 
 * Uses Redis for real-time metrics storage and Socket.IO for live dashboards
 */

const redisClient = require('./redisClient');
const EmergencyRequest = require('../models/EmergencyRequest');
const Ambulance = require('../models/Ambulance');
const Hospital = require('../models/Hospital');
const logger = require('./logger');

class RealtimeMonitor {
  constructor() {
    this.metricsKey = 'system:metrics';
    this.ambulanceMetricsKey = 'system:ambulances';
    this.requestMetricsKey = 'system:requests';
    this.hospitalMetricsKey = 'system:hospitals';
    this.queueMetricsKey = 'system:queue';
  }

  /**
   * Update ambulance status in real-time
   */
  async updateAmbulanceStatus(ambulanceId, status, metadata = {}) {
    try {
      const key = `ambulance:${ambulanceId}`;
      const data = {
        ambulanceId: ambulanceId.toString(),
        status, // AVAILABLE, ASSIGNED, EN_ROUTE, AT_HOSPITAL, MAINTENANCE, OFFLINE
        lastUpdate: Date.now(),
        ...metadata, // location, currentRequestId, eta, etc.
      };

      await redisClient.setex(key, 3600, JSON.stringify(data)); // 1 hour TTL

      // Update set of active ambulances
      await redisClient.sadd('active:ambulances', ambulanceId.toString());

      // Publish to monitoring channel
      await redisClient.publish('monitor:ambulance-status', JSON.stringify({
        type: 'ambulance-status-changed',
        ambulanceId: ambulanceId.toString(),
        status,
        timestamp: Date.now(),
      }));

      // Update system metrics
      await this.updateSystemMetrics();
    } catch (err) {
      logger.error(`Update ambulance status failed: ${err.message}`);
    }
  }

  /**
   * Update request state in real-time
   */
  async updateRequestStatus(requestId, status, assignmentState, metadata = {}) {
    try {
      const key = `request:${requestId}`;
      const data = {
        requestId: requestId.toString(),
        status,
        assignmentState,
        lastUpdate: Date.now(),
        ...metadata, // ambulanceId, hospitalId, priority, eta, etc.
      };

      await redisClient.setex(key, 3600, JSON.stringify(data)); // 1 hour TTL

      // Track request lifecycle for metrics
      const lifecycleKey = `request:lifecycle:${requestId}`;
      const lifecycle = JSON.parse((await redisClient.get(lifecycleKey)) || '{}');
      
      lifecycle[assignmentState] = Date.now();
      await redisClient.setex(lifecycleKey, 86400, JSON.stringify(lifecycle));

      // Publish to monitoring channel
      await redisClient.publish('monitor:request-status', JSON.stringify({
        type: 'request-status-changed',
        requestId: requestId.toString(),
        status,
        assignmentState,
        timestamp: Date.now(),
      }));

      // Update system metrics
      await this.updateSystemMetrics();
    } catch (err) {
      logger.error(`Update request status failed: ${err.message}`);
    }
  }

  /**
   * Get real-time system metrics snapshot
   */
  async getSystemMetrics() {
    try {
      const metrics = await redisClient.get(this.metricsKey);
      if (!metrics) {
        return this.computeSystemMetrics();
      }
      return JSON.parse(metrics);
    } catch (err) {
      logger.error(`Get system metrics failed: ${err.message}`);
      return {};
    }
  }

  /**
   * Compute system metrics from database/Redis
   */
  async computeSystemMetrics() {
    try {
      const [
        totalAmbulances,
        activeAmbulances,
        totalRequests,
        pendingRequests,
        assignedRequests,
        enRouteRequests,
        completedRequests,
        hospitals,
      ] = await Promise.all([
        Ambulance.countDocuments({ isActive: true }),
        redisClient.scard('active:ambulances'),
        EmergencyRequest.countDocuments(),
        EmergencyRequest.countDocuments({ assignmentState: 'PENDING' }),
        EmergencyRequest.countDocuments({ assignmentState: 'ASSIGNED' }),
        EmergencyRequest.countDocuments({ assignmentState: 'EN_ROUTE' }),
        EmergencyRequest.countDocuments({ status: 'COMPLETED' }),
        Hospital.countDocuments({ isActive: true }),
      ]);

      // Get average response times from recent completed requests
      const recentCompleted = await EmergencyRequest.find({
        status: 'COMPLETED',
        completionTime: { $gte: new Date(Date.now() - 3600000) }, // Last hour
      })
        .select('requestTime acceptedTime enRouteTime completionTime')
        .limit(100)
        .lean();

      let avgResponseTime = 0;
      let avgTransportTime = 0;
      if (recentCompleted.length > 0) {
        const responseTimes = recentCompleted
          .filter(r => r.acceptedTime)
          .map(r => (r.acceptedTime - r.requestTime) / 60000); // minutes

        const transportTimes = recentCompleted
          .filter(r => r.enRouteTime && r.completionTime)
          .map(r => (r.completionTime - r.enRouteTime) / 60000); // minutes

        avgResponseTime = responseTimes.length > 0
          ? Math.round(responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length)
          : 0;

        avgTransportTime = transportTimes.length > 0
          ? Math.round(transportTimes.reduce((a, b) => a + b, 0) / transportTimes.length)
          : 0;
      }

      const metrics = {
        timestamp: Date.now(),
        ambulances: {
          total: totalAmbulances,
          active: activeAmbulances,
          utilization: totalAmbulances > 0 ? ((activeAmbulances / totalAmbulances) * 100).toFixed(1) : 0,
        },
        requests: {
          total: totalRequests,
          pending: pendingRequests,
          assigned: assignedRequests,
          enRoute: enRouteRequests,
          completed: completedRequests,
          pendingPercentage: totalRequests > 0 ? ((pendingRequests / totalRequests) * 100).toFixed(1) : 0,
        },
        hospitals: hospitals,
        performance: {
          avgResponseTimeMinutes: avgResponseTime,
          avgTransportTimeMinutes: avgTransportTime,
          completedThisHour: recentCompleted.length,
        },
        healthStatus: this.computeHealthStatus(
          activeAmbulances,
          totalAmbulances,
          pendingRequests,
          enRouteRequests
        ),
      };

      // Cache for 30 seconds
      await redisClient.setex(this.metricsKey, 30, JSON.stringify(metrics));

      return metrics;
    } catch (err) {
      logger.error(`Compute system metrics failed: ${err.message}`);
      return {};
    }
  }

  /**
   * Compute system health status based on metrics
   */
  computeHealthStatus(activeAmbulances, totalAmbulances, pendingRequests, enRouteRequests) {
    const utilizationPercentage = totalAmbulances > 0
      ? (activeAmbulances / totalAmbulances) * 100
      : 0;

    // Health status based on multiple factors
    let status = 'HEALTHY';
    let issues = [];

    // Check ambulance utilization (>80% is high stress)
    if (utilizationPercentage > 80) {
      issues.push(`High ambulance utilization: ${utilizationPercentage.toFixed(1)}%`);
      status = 'WARNING';
    }

    // Check queue buildup (>50 pending requests)
    if (pendingRequests > 50) {
      issues.push(`Queue buildup: ${pendingRequests} pending requests`);
      status = 'WARNING';
    }

    // Check if queue is getting worse (>100 pending)
    if (pendingRequests > 100) {
      issues.push(`CRITICAL: Request queue overwhelming (${pendingRequests} pending)`);
      status = 'CRITICAL';
    }

    // Check active ambulances are responding
    if (activeAmbulances === 0 && totalAmbulances > 0) {
      issues.push('No active ambulances available');
      status = 'CRITICAL';
    }

    return {
      status, // HEALTHY, WARNING, CRITICAL
      issues,
      utilizationPercentage: utilizationPercentage.toFixed(1),
    };
  }

  /**
   * Update system metrics (triggers metrics recalculation)
   */
  async updateSystemMetrics() {
    try {
      const metrics = await this.computeSystemMetrics();

      // Publish metrics update to monitoring subscribers
      await redisClient.publish('monitor:system-metrics', JSON.stringify({
        type: 'metrics-update',
        metrics,
        timestamp: Date.now(),
      }));

      return metrics;
    } catch (err) {
      logger.error(`Update system metrics failed: ${err.message}`);
    }
  }

  /**
   * Get ambulance-specific metrics
   */
  async getAmbulanceMetrics(ambulanceId) {
    try {
      const key = `ambulance:${ambulanceId}`;
      const data = await redisClient.get(key);
      return data ? JSON.parse(data) : null;
    } catch (err) {
      logger.error(`Get ambulance metrics failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Get request-specific metrics and lifecycle timeline
   */
  async getRequestMetrics(requestId) {
    try {
      const [request, lifecycle] = await Promise.all([
        redisClient.get(`request:${requestId}`),
        redisClient.get(`request:lifecycle:${requestId}`),
      ]);

      const requestData = request ? JSON.parse(request) : null;
      const lifecycleData = lifecycle ? JSON.parse(lifecycle) : {};

      // Add computed timings
      if (Object.keys(lifecycleData).length > 0) {
        const times = {};
        const stateOrder = ['PENDING', 'ASSIGNED', 'ACCEPTED', 'EN_ROUTE', 'COMPLETED'];

        for (let i = 0; i < stateOrder.length - 1; i++) {
          const current = stateOrder[i];
          const next = stateOrder[i + 1];

          if (lifecycleData[current] && lifecycleData[next]) {
            const duration = (lifecycleData[next] - lifecycleData[current]) / 1000; // seconds
            times[`${current}_to_${next}`] = {
              seconds: duration,
              minutes: (duration / 60).toFixed(1),
            };
          }
        }

        return {
          ...requestData,
          lifecycle: lifecycleData,
          timings: times,
        };
      }

      return requestData;
    } catch (err) {
      logger.error(`Get request metrics failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Get hospital capacity and real-time metrics
   */
  async getHospitalMetrics(hospitalId) {
    try {
      const key = `hospital:${hospitalId}`;
      const data = await redisClient.get(key);

      if (!data) {
        // Compute from database
        const hospital = await Hospital.findById(hospitalId);
        if (!hospital) return null;

        // Count incoming ambulances
        const incomingRequests = await EmergencyRequest.countDocuments({
          assignedHospital: hospitalId,
          assignmentState: 'EN_ROUTE',
        });

        const metrics = {
          hospitalId: hospitalId.toString(),
          hospitalName: hospital.hospitalName,
          totalBeds: hospital.totalBeds || 50,
          availableBeds: Math.max(0, (hospital.totalBeds || 50) - incomingRequests),
          incomingAmbulances: incomingRequests,
          capacity: (((incomingRequests / (hospital.totalBeds || 50)) * 100)).toFixed(1),
          lastUpdate: Date.now(),
        };

        // Cache for 1 minute
        await redisClient.setex(key, 60, JSON.stringify(metrics));
        return metrics;
      }

      return JSON.parse(data);
    } catch (err) {
      logger.error(`Get hospital metrics failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Export metrics for Prometheus-compatible scraping
   */
  async getPrometheusMetrics() {
    try {
      const metrics = await this.getSystemMetrics();

      let output = '# HELP ers_ambulances_total Total ambulances in system\n';
      output += '# TYPE ers_ambulances_total gauge\n';
      output += `ers_ambulances_total{status="total"} ${metrics.ambulances?.total || 0}\n`;
      output += `ers_ambulances_total{status="active"} ${metrics.ambulances?.active || 0}\n`;

      output += '\n# HELP ers_requests_total Total requests in system\n';
      output += '# TYPE ers_requests_total gauge\n';
      output += `ers_requests_total{status="pending"} ${metrics.requests?.pending || 0}\n`;
      output += `ers_requests_total{status="assigned"} ${metrics.requests?.assigned || 0}\n`;
      output += `ers_requests_total{status="enroute"} ${metrics.requests?.enRoute || 0}\n`;
      output += `ers_requests_total{status="completed"} ${metrics.requests?.completed || 0}\n`;

      output += '\n# HELP ers_response_time_minutes Average response time in minutes\n';
      output += '# TYPE ers_response_time_minutes gauge\n';
      output += `ers_response_time_minutes ${metrics.performance?.avgResponseTimeMinutes || 0}\n`;

      output += '\n# HELP ers_system_health System health status\n';
      output += '# TYPE ers_system_health gauge\n';
      const healthValue = metrics.healthStatus?.status === 'HEALTHY' ? 1 : metrics.healthStatus?.status === 'WARNING' ? 0.5 : 0;
      output += `ers_system_health ${healthValue}\n`;

      return output;
    } catch (err) {
      logger.error(`Get Prometheus metrics failed: ${err.message}`);
      return '';
    }
  }
}

module.exports = new RealtimeMonitor();
