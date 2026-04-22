'use strict';

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const role = require('../middleware/role');
const { validate } = require('../middleware/validate');
const EmergencyRequest = require('../models/EmergencyRequest');
const Ambulance = require('../models/Ambulance');
const Hospital = require('../models/Hospital');
const redisClient = require('../utils/redisClient');
const haversine = require('../utils/haversine');
const logger = require('../utils/logger');
const io = require('../utils/socketIO');

/**
 * GET /api/hospital-tracking/incoming-ambulances
 * Get all incoming ambulances headed to this hospital
 */
router.get(
  '/incoming-ambulances',
  auth.authJwt,
  role.isHospital,
  async (req, res) => {
    try {
      const hospitalId = req.userId;

      // Find all EN_ROUTE requests assigned to this hospital
      const incomingRequests = await EmergencyRequest.find({
        assignedHospital: hospitalId,
        assignmentState: { $in: ['ACCEPTED', 'EN_ROUTE'] },
      })
        .select(
          '_id priority status type requestTime enRouteTime assignedAmbulanceId ' +
          'userName userPhone vitals driverLocation location'
        )
        .populate('assignedAmbulanceId', 'callSign isActive')
        .lean();

      const ambulances = await Promise.all(
        incomingRequests.map(async (req) => {
          const ambulance = req.assignedAmbulanceId;

          // Get real-time location from Redis
          const locationKey = `driver:location:${ambulance._id}`;
          const locationData = await redisClient.get(locationKey);
          const location = locationData ? JSON.parse(locationData) : null;

          let etaMinutes = null;
          let distanceKm = null;

          if (location && location.location) {
            // Calculate distance from driver to hospital
            const hospital = await Hospital.findById(hospitalId).select('location');
            if (hospital?.location?.coordinates) {
              distanceKm = haversine(
                location.location.coordinates[1],
                location.location.coordinates[0],
                hospital.location.coordinates[1],
                hospital.location.coordinates[0]
              );

              // Estimate ETA (default 60 km/h if speed not available)
              const speedKmh = location.speed || 60;
              etaMinutes = speedKmh > 0 ? Math.round((distanceKm / speedKmh) * 60) : null;
            }
          }

          return {
            requestId: req._id,
            ambulance: {
              id: ambulance._id,
              callSign: ambulance.callSign,
            },
            patient: {
              name: req.userName,
              phone: req.userPhone,
              vitals: req.vitals,
              priority: req.priority,
            },
            status: req.status,
            assignmentState: req.assignmentState,
            type: req.type,
            requestTime: req.requestTime,
            enRouteTime: req.enRouteTime,
            location: location || null,
            distanceKm: distanceKm?.toFixed(2),
            etaMinutes,
            lastLocationUpdate: location?.timestamp,
          };
        })
      );

      res.json({
        ambulances: ambulances.filter(a => a.location !== null), // Only show with active location
        count: ambulances.length,
      });
    } catch (err) {
      logger.error(`Get incoming ambulances failed: ${err.message}`, { stack: err.stack });
      res.status(500).json({ error: 'Failed to fetch ambulances' });
    }
  }
);

/**
 * GET /api/hospital-tracking/ambulance/:ambulanceId/tracking
 * Subscribe to real-time tracking for a specific ambulance
 * 
 * This endpoint handles Server-Sent Events (SSE) for real-time location streaming
 */
router.get(
  '/ambulance/:ambulanceId/tracking',
  auth.authJwt,
  role.isHospital,
  (req, res) => {
    const { ambulanceId } = req.params;
    const hospitalId = req.userId;

    try {
      // Set SSE headers
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('Access-Control-Allow-Origin', '*');

      // Send initial connection message
      res.write('data: {"type":"connected","message":"Tracking stream started"}\n\n');

      // Subscribe to location updates via Redis pub/sub
      const subscriber = redisClient.duplicate();
      const channel = `driver:location:${ambulanceId}`;

      subscriber.on('message', (chan, message) => {
        if (chan === channel) {
          try {
            const data = JSON.parse(message);
            res.write(`data: ${JSON.stringify(data)}\n\n`);
          } catch (parseErr) {
            logger.error(`SSE parse error: ${parseErr.message}`);
          }
        }
      });

      subscriber.subscribe(channel, (err) => {
        if (err) {
          logger.error(`Subscribe failed: ${err.message}`);
          res.write('data: {"type":"error","message":"Subscription failed"}\n\n');
          res.end();
        }
      });

      // Clean up on disconnect
      req.on('close', () => {
        subscriber.unsubscribe(channel);
        subscriber.quit();
        logger.info(`SSE tracking stream closed for ambulance ${ambulanceId}`);
      });

      // Send keep-alive every 30 seconds
      const keepAlive = setInterval(() => {
        res.write(':keep-alive\n\n');
      }, 30000);

      req.on('close', () => {
        clearInterval(keepAlive);
      });
    } catch (err) {
      logger.error(`Tracking stream failed: ${err.message}`);
      res.status(500).json({ error: 'Tracking failed' });
    }
  }
);

/**
 * GET /api/hospital-tracking/tracking-dashboard
 * Get comprehensive incoming ambulances dashboard data
 */
router.get(
  '/tracking-dashboard',
  auth.authJwt,
  role.isHospital,
  async (req, res) => {
    try {
      const hospitalId = req.userId;

      // Get incoming ambulances
      const incomingRequests = await EmergencyRequest.find({
        assignedHospital: hospitalId,
        assignmentState: { $in: ['ACCEPTED', 'EN_ROUTE'] },
      })
        .select(
          '_id priority status type requestTime enRouteTime assignedAmbulanceId ' +
          'userName userPhone vitals driverLocation'
        )
        .populate('assignedAmbulanceId', 'callSign isActive')
        .sort({ enRouteTime: 1 })
        .lean();

      // Group by priority
      const byPriority = {
        CRITICAL: [],
        HIGH: [],
        MEDIUM: [],
        LOW: [],
      };

      const ambulances = await Promise.all(
        incomingRequests.map(async (req) => {
          const ambulance = req.assignedAmbulanceId;
          const locationKey = `driver:location:${ambulance._id}`;
          const locationData = await redisClient.get(locationKey);
          const location = locationData ? JSON.parse(locationData) : null;

          const ambulanceData = {
            requestId: req._id,
            ambulanceCallSign: ambulance.callSign,
            patientName: req.userName,
            priority: req.priority,
            type: req.type,
            requestTime: req.requestTime,
            enRouteTime: req.enRouteTime,
            vitals: req.vitals,
            status: req.status,
            location: location?.location || null,
            etaMinutes: location?.eta,
            speed: location?.speed,
            heading: location?.heading,
            lastUpdate: location?.timestamp,
          };

          if (byPriority[req.priority]) {
            byPriority[req.priority].push(ambulanceData);
          }

          return ambulanceData;
        })
      );

      // Calculate capacity info
      const totalAmbulances = ambulances.length;
      const withETA = ambulances.filter(a => a.etaMinutes).length;
      const avgETA = ambulances
        .filter(a => a.etaMinutes)
        .reduce((sum, a) => sum + a.etaMinutes, 0) / withETA || 0;

      res.json({
        dashboard: {
          totalIncoming: totalAmbulances,
          readyBeds: req.query.beds || 10, // Query param for beds available
          ambulancesByPriority: byPriority,
          statistics: {
            totalAmbulances,
            withActiveLocation: ambulances.filter(a => a.location).length,
            averageETA: Math.round(avgETA),
            criticalCount: byPriority.CRITICAL.length,
            highCount: byPriority.HIGH.length,
          },
        },
      });
    } catch (err) {
      logger.error(`Dashboard fetch failed: ${err.message}`, { stack: err.stack });
      res.status(500).json({ error: 'Dashboard fetch failed' });
    }
  }
);

/**
 * POST /api/hospital-tracking/prepare-bed
 * Update bed preparation status when ambulance is nearby
 */
router.post(
  '/prepare-bed',
  auth.authJwt,
  role.isHospital,
  validate({
    body: {
      required: ['requestId', 'bedType', 'status'],
      isMongoId: ['requestId']
    }
  }),
  async (req, res) => {
    try {
      const hospitalId = req.userId;
      const { requestId, bedType, status } = req.body;

      // Verify request belongs to hospital
      const request = await EmergencyRequest.findById(requestId);
      if (!request || request.assignedHospital.toString() !== hospitalId.toString()) {
        return res.status(403).json({ error: 'Request not assigned to your hospital' });
      }

      // Store bed status in Redis
      const bedKey = `hospital:bed:${requestId}`;
      await redisClient.setex(
        bedKey,
        86400, // 24 hour TTL
        JSON.stringify({
          requestId: requestId.toString(),
          bedType,
          status,
          preparedAt: Date.now(),
        })
      );

      // Notify ambulance via Socket.IO
      io.to(`ambulance:${request.assignedAmbulanceId}`).emit('bed-prepared', {
        requestId: requestId.toString(),
        bedType,
        status,
        preparedAt: Date.now(),
      });

      res.json({
        success: true,
        message: `Bed status updated to ${status}`,
      });
    } catch (err) {
      logger.error(`Bed preparation update failed: ${err.message}`);
      res.status(500).json({ error: 'Update failed' });
    }
  }
);

module.exports = router;
