'use strict';

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const role = require('../middleware/role');
const realtimeMonitor = require('../utils/realtimeMonitor');
const logger = require('../utils/logger');

/**
 * GET /api/monitoring/system-metrics
 * Get current system-wide metrics (admin/dispatcher view)
 */
router.get(
  '/system-metrics',
  auth.authJwt,
  role.isAdmin,
  async (req, res) => {
    try {
      const metrics = await realtimeMonitor.getSystemMetrics();
      res.json({
        success: true,
        metrics,
        timestamp: Date.now(),
      });
    } catch (err) {
      logger.error(`System metrics fetch failed: ${err.message}`);
      res.status(500).json({ error: 'Failed to fetch metrics' });
    }
  }
);

/**
 * GET /api/monitoring/ambulance/:ambulanceId/metrics
 * Get specific ambulance metrics and performance data
 */
router.get(
  '/ambulance/:ambulanceId/metrics',
  auth.authJwt,
  async (req, res) => {
    try {
      const { ambulanceId } = req.params;
      const metrics = await realtimeMonitor.getAmbulanceMetrics(ambulanceId);

      if (!metrics) {
        return res.status(404).json({ error: 'Ambulance not found or no recent activity' });
      }

      res.json({
        success: true,
        metrics,
        timestamp: Date.now(),
      });
    } catch (err) {
      logger.error(`Ambulance metrics fetch failed: ${err.message}`);
      res.status(500).json({ error: 'Failed to fetch metrics' });
    }
  }
);

/**
 * GET /api/monitoring/request/:requestId/metrics
 * Get request lifecycle metrics and timing information
 */
router.get(
  '/request/:requestId/metrics',
  auth.authJwt,
  async (req, res) => {
    try {
      const { requestId } = req.params;
      const metrics = await realtimeMonitor.getRequestMetrics(requestId);

      if (!metrics) {
        return res.status(404).json({ error: 'Request metrics not available' });
      }

      res.json({
        success: true,
        metrics,
        timestamp: Date.now(),
      });
    } catch (err) {
      logger.error(`Request metrics fetch failed: ${err.message}`);
      res.status(500).json({ error: 'Failed to fetch metrics' });
    }
  }
);

/**
 * GET /api/monitoring/hospital/:hospitalId/capacity
 * Get hospital capacity and incoming ambulance metrics
 */
router.get(
  '/hospital/:hospitalId/capacity',
  auth.authJwt,
  role.isHospital,
  async (req, res) => {
    try {
      const { hospitalId } = req.params;
      const metrics = await realtimeMonitor.getHospitalMetrics(hospitalId);

      if (!metrics) {
        return res.status(404).json({ error: 'Hospital not found' });
      }

      res.json({
        success: true,
        metrics,
        timestamp: Date.now(),
      });
    } catch (err) {
      logger.error(`Hospital capacity fetch failed: ${err.message}`);
      res.status(500).json({ error: 'Failed to fetch capacity' });
    }
  }
);

/**
 * GET /api/monitoring/health-status
 * Get system health status for alerting
 */
router.get(
  '/health-status',
  auth.authJwt,
  role.isAdmin,
  async (req, res) => {
    try {
      const metrics = await realtimeMonitor.getSystemMetrics();
      const health = metrics.healthStatus || { status: 'UNKNOWN', issues: [] };

      // Return appropriate HTTP status code
      const statusCode = health.status === 'HEALTHY' ? 200 : health.status === 'WARNING' ? 202 : 503;

      res.status(statusCode).json({
        success: true,
        health,
        metrics: {
          ambulances: metrics.ambulances,
          requests: metrics.requests,
          performance: metrics.performance,
        },
        timestamp: Date.now(),
      });
    } catch (err) {
      logger.error(`Health status fetch failed: ${err.message}`);
      res.status(500).json({
        success: false,
        health: { status: 'CRITICAL', issues: ['Unable to fetch health status'] },
        error: 'Health check failed',
      });
    }
  }
);

/**
 * WebSocket monitoring stream (requires Socket.IO connection)
 * Clients connect to Socket.IO room: 'monitoring:metrics'
 * Receives real-time metric updates via 'metrics-update' event
 */
router.get(
  '/subscribe',
  (req, res) => {
    res.json({
      message: 'Use Socket.IO connection to room "monitoring:metrics" for real-time updates',
      usage: 'socket.emit("join", "monitoring:metrics"); socket.on("metrics-update", (data) => {...})',
    });
  }
);

module.exports = router;
