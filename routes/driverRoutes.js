'use strict';

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const role = require('../middleware/role');
const { validate } = require('../middleware/validate');
const Ambulance = require('../models/Ambulance');
const EmergencyRequest = require('../models/EmergencyRequest');
const { AuditLogger } = require('../models/AuditLog');
const eventConsistency = require('../utils/eventConsistency');
const redisClient = require('../utils/redisClient');
const locationSmoother = require('../utils/locationSmoother');
const { v4: uuidv4 } = require('uuid');
const haversine = require('../utils/haversine');
const logger = require('../utils/logger');
const io = require('../utils/socketIO');

let offlineDriverManagerModule = null;
const shouldUseOfflineDriverManager =
  process.env.NODE_ENV !== 'test' || process.env.ENABLE_OFFLINE_DRIVER_MANAGER_IN_TESTS === 'true';

const getOfflineDriverManager = () => {
  if (!shouldUseOfflineDriverManager) {
    return {
      recordHeartbeat: async () => {},
      handleDriverReconnect: async () => ({
        offlineDurationMs: 0,
        processedEvents: 0,
      }),
    };
  }

  if (!offlineDriverManagerModule) {
    offlineDriverManagerModule = require('../utils/offlineDriverManager');
  }

  return offlineDriverManagerModule;
};

/**
 * PATCH /api/driver/location
 * Update driver's real-time location during en-route
 * 
 * POST Body:
 *   {
 *     ambulanceId: ObjectId,
 *     requestId: ObjectId,
 *     location: { longitude, latitude },
 *     speed?: km/h,
 *     heading?: degrees,
 *     accuracy?: meters
 *   }
 */

router.patch(
  '/location',
  auth.authJwt,
  role.isAmbulance,
  validate({
    body: {
      required: ['ambulanceId', 'requestId', 'location'],
      isMongoId: ['ambulanceId', 'requestId']
    }
  }),
  async (req, res) => {
    try {
      const { ambulanceId, requestId, location, speed, heading, accuracy } = req.body;
      const driverId = req.userId;

      // Verify ambulance ownership
      const ambulance = await Ambulance.findById(ambulanceId);
      if (!ambulance || ambulance.driverId.toString() !== driverId.toString()) {
        return res.status(403).json({ error: 'Unauthorized: not your ambulance' });
      }

      // Verify request is assigned to this ambulance and in EN_ROUTE state
      const request = await EmergencyRequest.findById(requestId);
      if (!request || request.assignedAmbulanceId.toString() !== ambulanceId.toString()) {
        return res.status(404).json({ error: 'Request not assigned to this ambulance' });
      }

      if (request.assignmentState !== 'EN_ROUTE') {
        return res.status(400).json({ error: `Cannot update location in ${request.assignmentState} state` });
      }

      // Store driver location KV in Redis for Redis-backed Socket.IO room pub/sub
      const locationKey = `driver:location:${ambulanceId}`;
      const locationData = {
        ambulanceId: ambulanceId.toString(),
        requestId: requestId.toString(),
        driverId: driverId.toString(),
        location: {
          type: 'Point',
          coordinates: [location.longitude, location.latitude],
        },
        speed: speed || 0,
        heading: heading || 0,
        accuracy: accuracy || 0,
        timestamp: Date.now(),
      };

      // Store in Redis for 1-hour TTL (real-time)
      await redisClient.setex(locationKey, 3600, JSON.stringify(locationData));

      // Calculate ETA to hospital
      const hospital = await require('../models/Hospital').findById(request.assignedHospital);
      if (!hospital) {
        return res.status(500).json({ error: 'Hospital not found' });
      }

      const distanceKm = haversine(
        location.latitude,
        location.longitude,
        hospital.location.coordinates[1],
        hospital.location.coordinates[0]
      );

      // Estimate ETA based on current speed (km/h)
      const speedKmh = speed || 60; // Default 60 km/h if not provided
      const eta = speedKmh > 0 ? Math.round((distanceKm / speedKmh) * 60) : null; // minutes

      // Update request driverLocation in MongoDB (periodic sync, not per update)
      // This is for historical tracking and audit, not real-time
      await EmergencyRequest.findByIdAndUpdate(
        requestId,
        {
          $set: {
            driverLocation: locationData.location,
          },
        },
        { new: true }
      );

      // Publish to Redis channel for real-time subscription (Socket.IO rooms)
      const channel = `request:tracking:${requestId}`;
      await redisClient.publish(channel, JSON.stringify({
        type: 'driver-location-update',
        ambulanceId: ambulanceId.toString(),
        location: locationData.location,
        distanceToHospital: distanceKm.toFixed(2),
        eta, // minutes
        speed,
        heading,
        accuracy,
        timestamp: Date.now(),
      }));

      // Emit Socket.IO event if clients in hospital room
      io.to(`hospital:tracking:${request.assignedHospital}`).emit('driver-location', {
        ambulanceId: ambulanceId.toString(),
        requestId: requestId.toString(),
        location: locationData.location,
        distanceToHospital: distanceKm.toFixed(2),
        eta,
        speed,
        heading,
        timestamp: Date.now(),
      });

      // Audit log
      await AuditLogger.log({
        action: 'DRIVER_LOCATION_UPDATE',
        entity: { id: requestId, type: 'EmergencyRequest' },
        actor: driverId,
        changes: {
          before: request.driverLocation || null,
          after: locationData.location,
          distanceToHospital: distanceKm.toFixed(2),
          eta,
        },
        metadata: {
          ambulanceId: ambulanceId.toString(),
          correlationId: req.requestId,
          priority: request.priority,
        },
      });

      res.json({
        success: true,
        distanceToHospital: distanceKm.toFixed(2),
        eta,
        message: 'Location updated',
      });
    } catch (err) {
      logger.error(`Driver location update failed: ${err.message}`, { stack: err.stack });
      res.status(500).json({ error: 'Location update failed' });
    }
  }
);

/**
 * GET /api/driver/current-assignment
 * Get current assignment details for driver
 */
router.get(
  '/current-assignment',
  auth.authJwt,
  role.isAmbulance,
  async (req, res) => {
    try {
      const driverId = req.userId;

      const ambulance = await Ambulance.findOne({ driverId }).select('_id');
      if (!ambulance) {
        return res.status(404).json({ error: 'Ambulance not found' });
      }

      // Get active request (EN_ROUTE or ACCEPTED state)
      const request = await EmergencyRequest.findOne({
        assignedAmbulanceId: ambulance._id,
        assignmentState: { $in: ['ACCEPTED', 'EN_ROUTE'] },
      })
        .select(
          '_id status assignmentState userId userName userPhone location ' +
          'priority description type vitals assignedHospital acceptedTime enRouteTime'
        )
        .populate('assignedHospital', 'hospitalName address location phone');

      if (!request) {
        return res.json({ assignment: null });
      }

      // Calculate real-time distance to patient and hospital
      const patientLat = request.location.coordinates[1];
      const patientLon = request.location.coordinates[0];

      const distToPatient = request.driverLocation
        ? haversine(
            req.body?.driverLocation?.latitude || 0,
            req.body?.driverLocation?.longitude || 0,
            patientLat,
            patientLon
          )
        : null;

      const hospitalLat = request.assignedHospital?.location?.coordinates[1];
      const hospitalLon = request.assignedHospital?.location?.coordinates[0];

      const distToHospital = request.driverLocation && hospitalLat
        ? haversine(
            request.driverLocation.coordinates[1],
            request.driverLocation.coordinates[0],
            hospitalLat,
            hospitalLon
          )
        : null;

      res.json({
        assignment: {
          requestId: request._id,
          patientName: request.userName,
          patientPhone: request.userPhone,
          status: request.status,
          assignmentState: request.assignmentState,
          priority: request.priority,
          type: request.type,
          description: request.description,
          vitals: request.vitals,
          patientLocation: {
            lat: patientLat,
            lon: patientLon,
          },
          distanceToPatient: distToPatient?.toFixed(2),
          hospital: {
            id: request.assignedHospital?._id,
            name: request.assignedHospital?.hospitalName,
            address: request.assignedHospital?.address,
            phone: request.assignedHospital?.phone,
          },
          distanceToHospital: distToHospital?.toFixed(2),
          acceptedTime: request.acceptedTime,
          enRouteTime: request.enRouteTime,
        },
      });
    } catch (err) {
      logger.error(`Get current assignment failed: ${err.message}`, { stack: err.stack });
      res.status(500).json({ error: 'Failed to fetch assignment' });
    }
  }
);

/**
 * GET /api/driver/assignment-history
 * Get driver's recent completed assignments for analytics
 */
router.get(
  '/assignment-history',
  auth.authJwt,
  role.isAmbulance,
  async (req, res) => {
    try {
      const driverId = req.userId;
      const limit = Math.min(parseInt(req.query.limit) || 10, 50);

      const ambulance = await Ambulance.findOne({ driverId }).select('_id');
      if (!ambulance) {
        return res.status(404).json({ error: 'Ambulance not found' });
      }

      const history = await EmergencyRequest.find({
        assignedAmbulanceId: ambulance._id,
        status: 'COMPLETED',
      })
        .select(
          '_id userName userPhone priority type status requestTime completionTime ' +
          'acceptedTime enRouteTime assignmentState'
        )
        .sort({ completionTime: -1 })
        .limit(limit)
        .lean();

      const enriched = history.map(req => ({
        requestId: req._id,
        patientName: req.userName,
        patientPhone: req.userPhone,
        priority: req.priority,
        type: req.type,
        requestTime: req.requestTime,
        acceptedTime: req.acceptedTime,
        enRouteTime: req.enRouteTime,
        completedTime: req.completionTime,
        responseTime: req.acceptedTime ? Math.round((req.acceptedTime - req.requestTime) / 60000) : null, // minutes
        transportTime: req.enRouteTime && req.completionTime
          ? Math.round((req.completionTime - req.enRouteTime) / 60000)
          : null,
      }));

      res.json({
        history: enriched,
        count: enriched.length,
      });
    } catch (err) {
      logger.error(`Get assignment history failed: ${err.message}`, { stack: err.stack });
      res.status(500).json({ error: 'Failed to fetch history' });
    }
  }
);

/**
 * POST /api/driver/heartbeat
 * Send heartbeat to detect offline drivers
 * Call every 10-15 seconds while app is active
 */
router.post(
  '/heartbeat',
  auth.authJwt,
  role.isAmbulance,
  async (req, res) => {
    try {
      const driverId = req.userId;
      const ambulance = await Ambulance.findOne({ driverId }).select('_id');
      
      if (!ambulance) {
        return res.status(404).json({ error: 'Ambulance not found' });
      }

      // Record heartbeat
      await getOfflineDriverManager().recordHeartbeat(ambulance._id, driverId);

      res.json({ 
        success: true,
        timestamp: Date.now(),
      });
    } catch (err) {
      logger.error(`Heartbeat recording failed: ${err.message}`);
      res.status(500).json({ error: 'Heartbeat failed' });
    }
  }
);

/**
 * POST /api/driver/reconnect
 * Handle reconnection after offline period
 * Returns: missed events and current state to sync UI
 */
router.post(
  '/reconnect',
  auth.authJwt,
  role.isAmbulance,
  async (req, res) => {
    try {
      const driverId = req.userId;
      const ambulance = await Ambulance.findOne({ driverId }).select('_id');

      if (!ambulance) {
        return res.status(404).json({ error: 'Ambulance not found' });
      }

      // Handle reconnection
      const reconnectStatus = await getOfflineDriverManager().handleDriverReconnect(
        ambulance._id,
        driverId
      );

      res.json({
        success: true,
        reconnectStatus,
        recovery: {
          timestamp: Date.now(),
        },
      });
    } catch (err) {
      logger.error(`Reconnect handling failed: ${err.message}`);
      res.status(500).json({ error: 'Reconnect failed' });
    }
  }
);

module.exports = router;
