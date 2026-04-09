'use strict';

const mongoose         = require('mongoose');
const axios            = require('axios');
const EmergencyRequest = require('../models/EmergencyRequest');
const Ambulance        = require('../models/Ambulance');
const Hospital         = require('../models/Hospital');
const DispatchLog      = require('../models/DispatchLog');
const AppError         = require('../utils/AppError');
const logger           = require('../utils/logger');
const { haversineDistance } = require('../utils/haversine');
const redisClient = require('../utils/redisClient');
const { addDispatchJob, getQueueStats } = require('../utils/dispatchQueue');
const { allocateQueuedRequest, handleRejection } = require('../utils/dispatchEngine');
const CircuitBreaker = require('../utils/circuitBreaker');
const DynamicDispatchScorer = require('../utils/dynamicScorer');
const RequestStateMachine = require('../utils/requestStateMachine');
const LoadShedder = require('../utils/loadShedder');
const eventConsistency = require('../utils/eventConsistency');
const { AuditLogger } = require('../models/AuditLog');
const cache = require('../utils/cache');
const realtimeMonitor = require('../utils/realtimeMonitor');
const anomalyDetector = require('../utils/anomalyDetector');
const User = require('../models/User');
const {
  REQUEST_PRIORITY,
  REQUEST_PRIORITY_VALUES, // FIX: use the array, not the object, for .includes()
  REQUEST_TYPES,
  REQUEST_TYPES_VALUES,    // FIX: same
  REQUEST_STATUS,
  REQUEST_STATUS_VALUES,
  AMBULANCE_STATUS,
} = require('../utils/constants');

const OSRM_ROUTING_URL = process.env.OSRM_ROUTING_URL || process.env.OSRM_URL || '';
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || '';
const ROUTE_PROVIDER = process.env.ROUTE_PROVIDER || (GOOGLE_MAPS_API_KEY ? 'google' : 'osrm');

const routeCircuitBreaker = new CircuitBreaker({
  failureThreshold: 3,
  recoveryTimeout: 30000, // 30 seconds
});

const dynamicScorer = new DynamicDispatchScorer();
const loadShedder = new LoadShedder();

const transactionUnsupportedError = /Transactions are not supported on the standalone server|transaction numbers are only allowed on a replica set/i;
let mongoTransactionsSupported = null;

const startTransactionSession = async () => {
  let session = null;
  let useTransaction = true;

  try {
    session = await mongoose.startSession();
    session.startTransaction();
    if (mongoTransactionsSupported !== true) {
      logger.info('[Mongo] Running with transactions');
      mongoTransactionsSupported = true;
    }
    return { session, useTransaction };
  } catch (err) {
    if (err.name === 'MongoServerError' && transactionUnsupportedError.test(err.message)) {
      if (mongoTransactionsSupported !== false) {
        logger.warn('[Mongo] Running WITHOUT transactions (standalone mode)', { error: err.message });
        mongoTransactionsSupported = false;
      }
      useTransaction = false;
      return { session: null, useTransaction };
    }
    if (session) session.endSession();
    throw err;
  }
};

const commitSession = async (sessionData) => {
  if (!sessionData) return;
  const { session, useTransaction } = sessionData;
  if (useTransaction && session && session.inTransaction()) {
    await session.commitTransaction();
    session.endSession();
  }
};

const abortSession = async (sessionData) => {
  if (!sessionData) return;
  const { session, useTransaction } = sessionData;
  if (useTransaction && session && session.inTransaction()) {
    await session.abortTransaction();
    session.endSession();
  }
};

const buildOsrmUrl = (from, to) => {
  const [fromLng, fromLat] = from;
  const [toLng, toLat] = to;
  return `${OSRM_ROUTING_URL.replace(/\/$/, '')}/route/v1/driving/${fromLng},${fromLat};${toLng},${toLat}?overview=false&annotations=duration,distance`;
};

const buildGoogleDirectionsUrl = (from, to) => {
  const [fromLng, fromLat] = from;
  const [toLng, toLat] = to;
  return `https://maps.googleapis.com/maps/api/directions/json?origin=${fromLat},${fromLng}&destination=${toLat},${toLng}&departure_time=now&key=${GOOGLE_MAPS_API_KEY}`;
};

const getRouteInfo = async (from, to) => {
  return routeCircuitBreaker.execute(async () => {
    if (ROUTE_PROVIDER === 'google' && GOOGLE_MAPS_API_KEY) {
      const googleUrl = buildGoogleDirectionsUrl(from, to);
      const response = await axios.get(googleUrl);
      if (response.data?.status === 'OK' && Array.isArray(response.data.routes) && response.data.routes.length) {
        const leg = response.data.routes[0].legs[0];
        return {
          duration: leg.duration.value,
          distance: leg.distance.value,
          provider: 'google',
        };
      }
      throw new Error(`Google Directions failed: ${response.data?.status || 'unknown'}`);
    }

    if (!OSRM_ROUTING_URL) {
      throw new Error('OSRM_ROUTING_URL not configured');
    }

    const osrmUrl = buildOsrmUrl(from, to);
    const response = await axios.get(osrmUrl);
    if (response.data?.code === 'Ok' && Array.isArray(response.data.routes) && response.data.routes.length) {
      return {
        duration: Math.round(response.data.routes[0].duration),
        distance: Math.round(response.data.routes[0].distance),
        provider: 'osrm',
      };
    }
    throw new Error(`OSRM route failed: ${response.data?.code || 'unknown'}`);
  });
};

const fallbackEta = (from, to) => {
  const seconds = haversineDistance(from[1], from[0], to[1], to[0]) / ((40 * 1000) / 3600);
  return Math.round(seconds);
};

const estimateEta = async (from, to) => {
  const cacheKey = `eta:${from.join(',')}:${to.join(',')}`;
  const cached = redisClient && typeof redisClient.get === 'function'
    ? await redisClient.get(cacheKey)
    : null;
  if (cached) return parseInt(cached);

  try {
    const route = await getRouteInfo(from, to);
    const eta = route.duration;
    if (redisClient && typeof redisClient.setex === 'function') {
      await redisClient.setex(cacheKey, 3600, eta.toString()); // Cache for 1 hour
    }
    return eta;
  } catch (err) {
    logger.warn('Route ETA calculation failed, falling back to straight-line estimate', { error: err.message });
    const fallback = fallbackEta(from, to);
    return fallback;
  }
};

const findAvailableHospital = async (location, requestType, sessionData) => {
  const { session, useTransaction } = sessionData;
  const maxDistance = 50_000;
  const filter = {
    location: {
      $near: {
        $geometry: location,
        $maxDistance: maxDistance,
      },
    },
    isActive: true,
    capacityStatus: { $in: ['AVAILABLE', 'LIMITED'] },
    // Ensure location data is valid
    'location.type': 'Point',
    'location.coordinates': { $exists: true, $size: 2 },
  };

  if (requestType && requestType !== REQUEST_TYPES.MEDICAL) {
    filter.specialties = { $in: [requestType] };
  }

  const query = Hospital.findOne(filter)
    .populate('userId', 'name email phone');

  if (useTransaction && session) {
    query.session(session);
  }

  return query;
};

const emitDriverRoom = (io, driverId, event, payload) => {
  if (!io || !driverId) return;
  const target = String(driverId);
  io.to(`driver_${target}`).emit(event, payload);
  io.to(`user_${target}`).emit(event, payload);
};

const processQueuedAssignment = async (io) => {
  let sessionData;

  try {
    sessionData = await startTransactionSession();
    const { session, useTransaction } = sessionData;

    const result = await allocateQueuedRequest(session, useTransaction);

    if (!result) {
      await abortSession(sessionData);
      return null;
    }

    await commitSession(sessionData);

    // Update real-time monitoring for ambulance and request
    await realtimeMonitor.updateAmbulanceStatus(
      result.ambulance._id,
      'ASSIGNED',
      {
        currentRequestId: result.request._id.toString(),
        location: result.ambulance.currentLocation,
      }
    );
    await realtimeMonitor.updateRequestStatus(
      result.request._id,
      result.request.status,
      'ASSIGNED',
      {
        ambulanceId: result.ambulance._id.toString(),
        priority: result.request.priority,
        eta: Math.round(await estimateEta(
          result.ambulance.currentLocation.coordinates,
          result.request.location.coordinates
        ) / 60), // Convert to minutes
      }
    );

    if (io) {
      const queuedEta = await estimateEta(
        result.ambulance.currentLocation.coordinates,
        result.request.location.coordinates
      );

      emitDriverRoom(io, result.ambulance.driverId, 'dispatchAssigned', {
        requestId:       result.request._id,
        location:        result.request.location,
        priority:        result.request.priority,
        eta:             Math.round(queuedEta / 60),
        patientName:     result.request.userName,
        patientPhone:    result.request.userPhone,
        assignedHospital: result.request.assignedHospital || null,
      });

      io.to(`user_${result.request.userId}`).emit('ambulanceAssigned', {
        requestId:   result.request._id,
        ambulanceId: result.ambulance._id,
        ambulancePlate: result.ambulance.plateNumber,
        eta:         Math.round(queuedEta / 60),
        assignedHospital: result.request.assignedHospital || null,
      });

      io.to('admins').emit('dispatchAllocated', {
        requestId: result.request._id,
        ambulanceId: result.ambulance._id,
      });
    }

    return result;
  } catch (err) {
    if (sessionData) await abortSession(sessionData);

    logger.error('Failed to allocate queued request', err);
    return null;
  }
};

// â”€â”€â”€ Internal helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Find the nearest available ambulance to the given [lng, lat] coordinates.
 * Uses MongoDB $near for efficient geospatial lookup.
 *
 * @param {{ coordinates: [number, number] }} location - GeoJSON Point
 * @param {import('mongoose').ClientSession} session
 * @returns {Promise<import('mongoose').Document|null>}
 */
const findNearestAmbulance = async (location, session) =>
  Ambulance.findOne({
    status: AMBULANCE_STATUS.AVAILABLE,
    currentLocation: {
      $near: {
        $geometry:    { type: 'Point', coordinates: location.coordinates },
        $maxDistance: 50_000, // 50 km search radius
      },
    },
  }).session(session);

/**
 * Assign an ambulance to a request within an active transaction.
 *
 * @param {import('mongoose').Document} request
 * @param {import('mongoose').Document} ambulance
 * @param {import('mongoose').ClientSession} session
 */
const assignAmbulance = async (request, ambulance, session) => {
  ambulance.status = AMBULANCE_STATUS.ASSIGNED;
  await ambulance.save({ session });

  request.status              = REQUEST_STATUS.ASSIGNED;
  request.assignedAmbulanceId = ambulance._id;
  request.allocationTime      = new Date();
  await request.save({ session });

  await DispatchLog.findOneAndUpdate(
    { requestId: request._id },
    {
      $setOnInsert: { requestId: request._id },
      $set: {
        ambulanceId:  ambulance._id,
        status:       'ACTIVE',
        dispatchedAt: new Date(),
      },
      $push: {
        logs: { message: `Ambulance ${ambulance.plateNumber} assigned` },
      },
    },
    { session, upsert: true }
  );
};

// â”€â”€â”€ POST /api/dispatch/request â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * @desc  Citizen raises a new SOS emergency request
 * @route POST /api/dispatch/request
 * @access Private (Citizen)
 */
exports.newRequest = async (req, res, next) => {
  let sessionData = null;

  let ambulance = null;
  let eta = null;

  try {
    const {
      latitude,
      longitude,
      priority,
      type,
      description,
      allergies,
      triageNotes,
      medicalHistorySummary,
      vitals,
    } = req.body;

    // â”€â”€ Validation first (fast-fail before queue/DB-heavy checks) â”€â”€
    if (latitude == null || longitude == null) {
      throw new AppError('latitude and longitude are required', 400);
    }

    const locLng = parseFloat(longitude);
    const locLat = parseFloat(latitude);

    if (
      isNaN(locLng) || isNaN(locLat) ||
      locLng < -180 || locLng > 180 ||
      locLat < -90 || locLat > 90
    ) {
      throw new AppError('Invalid coordinates', 400);
    }

    // â”€â”€ Load shedding: reject low-priority during extreme overload â”€â”€
    let metrics = { waiting: 0, allocations: 0, rejections: 0 };
    try {
      metrics = await getQueueStats();
    } catch (metricsErr) {
      logger.warn('Unable to read dispatch queue metrics; skipping load shedding', {
        error: metricsErr.message,
      });
    }

    loadShedder.updateStatus(metrics);
    if (process.env.NODE_ENV === 'production' && loadShedder.shouldShedRequest(priority)) {
      const backoffMs = loadShedder.getBackoffTime();
      return res.status(503).json({
        success: false,
        message: 'System overload: please retry in ' + (backoffMs / 1000) + ' seconds',
        backoffMs,
        shedStatus: loadShedder.getStatus(),
      });
    }
    
    sessionData = await startTransactionSession();
    const { session, useTransaction } = sessionData;

    // â”€â”€ Prevent duplicate active request â”€â”€
    const existingQuery = EmergencyRequest.findOne({
      userId: req.user._id,
      status: { $in: ['PENDING', 'ASSIGNED', 'EN_ROUTE'] },
    });

    if (useTransaction && session) {
      existingQuery.session(session);
    }

    const existingActive = await existingQuery;

    if (existingActive) {
      throw new AppError('You already have an active emergency request', 400);
    }

    // â”€â”€ Anomaly detection â”€â”€
    const anomalies = await anomalyDetector.detectAnomalies({
      userId: req.user._id,
      location: { latitude: locLat, longitude: locLng },
      priority,
      type,
      vitals,
      requestTime: new Date(),
    });

    if (anomalies.isAnomaly) {
      const severity = anomalies.severity;
      logger.warn('Anomaly detected in emergency request', {
        userId: req.user._id,
        anomalies: anomalies.reasons,
        severity,
      });

      // Block high-severity anomalies
      if (severity === 'high') {
        await abortSession(sessionData);
        return res.status(403).json({
          success: false,
          message: 'Request blocked due to security concerns',
          requestId: req.requestId,
        });
      }

      // Log medium-severity for monitoring
      if (severity === 'medium') {
        logger.warn('Medium-severity anomaly requires validation', {
          userId: req.user._id,
          requestId: req.requestId,
        });
      }
    }

    const location = { type: 'Point', coordinates: [locLng, locLat] };

    // â”€â”€ Create request â”€â”€
    const createOptions = {};
    if (useTransaction && session) {
      createOptions.session = session;
    }

    const [request] = await EmergencyRequest.create([{
      userId: req.user._id,
      userName: req.user.name,
      userPhone: req.user.phone,
      location,
      priority: priority || 'MEDIUM',
      status: 'PENDING',
      type: type || 'MEDICAL',
      description: description || '',
      allergies: allergies || '',
      triageNotes: triageNotes || '',
      medicalHistorySummary: medicalHistorySummary || '',
      vitals: {
        heartRate: Number.isFinite(Number(vitals?.heartRate)) ? Number(vitals.heartRate) : undefined,
        bloodPressure: vitals?.bloodPressure || undefined,
        respiratoryRate: Number.isFinite(Number(vitals?.respiratoryRate)) ? Number(vitals.respiratoryRate) : undefined,
        temperature: Number.isFinite(Number(vitals?.temperature)) ? Number(vitals.temperature) : undefined,
        oxygenSaturation: Number.isFinite(Number(vitals?.oxygenSaturation)) ? Number(vitals.oxygenSaturation) : undefined,
      },
      requestTime: new Date(),
    }], createOptions);

    const hospital = await findAvailableHospital(location, request.type, sessionData);
    if (hospital?.userId) {
      request.assignedHospital = hospital.userId;
      const saveOptions = {};
      if (useTransaction && session) {
        saveOptions.session = session;
      }
      await request.save(saveOptions);
    }

    // Commit only DB work first, then enqueue for dispatch.
    await commitSession(sessionData);

    const priorityMap = { CRITICAL: 3, HIGH: 2, MEDIUM: 1, LOW: 0 };
    const jobPriority = priorityMap[request.priority] || 1;
    try {
      await addDispatchJob(request._id.toString(), 'allocate', null, jobPriority);
    } catch (queueErr) {
      logger.error('Failed to enqueue dispatch job after request commit', {
        requestId: request._id.toString(),
        error: queueErr.message,
      });
    }

    // Invalidate emergency-related cache immediately
    await cache.invalidateEmergencyData();

    // Update real-time monitoring metrics
    await realtimeMonitor.updateRequestStatus(
      request._id,
      request.status,
      'PENDING',
      {
        priority: request.priority,
        location: request.location,
      }
    );

    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // ðŸ”¥ SAFE ZONE (NO TRANSACTION)
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    const io = req.app.get('io');

    if (io) {
      io.to(`user_${req.user._id}`).emit('requestCreated', {
        requestId: request._id,
        status: 'PENDING',
        message: 'Your emergency request has been submitted and is being processed.',
      });

      io.to('dispatchers').emit('newEmergencyRequest', {
        requestId: request._id,
        location: request.location,
        priority: request.priority,
        userName: req.user.name,
        userPhone: req.user.phone,
      });
    }

    res.status(201).json({
      success: true,
      data: request,
      allocated: false,
    });

  } catch (err) {
    // âœ… SAFE abort
    await abortSession(sessionData);
    next(err);
  }
};

// â”€â”€â”€ PUT /api/dispatch/:id/response â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * @desc  Driver accepts or rejects their dispatch assignment
 * @route PUT /api/dispatch/:id/response
 * @access Private (Driver)
 */
exports.driverResponse = async (req, res, next) => {
  let sessionData;

  try {
    sessionData = await startTransactionSession();
    const { session, useTransaction } = sessionData;

    const { accept } = req.body;
    if (typeof accept !== 'boolean') {
      throw new AppError('"accept" must be a boolean', 400);
    }

    const requestQuery = EmergencyRequest.findById(req.params.id);
    if (useTransaction && session) {
      requestQuery.session(session);
    }
    const request = await requestQuery;
    if (!request) throw new AppError('Request not found', 404);

    if (request.status !== REQUEST_STATUS.ASSIGNED) {
      throw new AppError('This request is no longer available for response', 400);
    }

    const ambulanceQuery = Ambulance.findOne({ driverId: req.user._id });
    if (useTransaction && session) {
      ambulanceQuery.session(session);
    }
    const myAmb = await ambulanceQuery;
    if (!myAmb) throw new AppError('Ambulance not found for this driver', 404);

    if (String(request.assignedAmbulanceId) !== String(myAmb._id)) {
      throw new AppError('Not your assignment', 403);
    }

    const logEntry = {
      message:  accept ? 'Driver accepted assignment' : 'Driver rejected assignment',
      driverId: req.user._id,
    };

    if (!accept) {
      const logOptions = { upsert: true };
      if (useTransaction && session) {
        logOptions.session = session;
      }

      await DispatchLog.findOneAndUpdate(
        { requestId: request._id },
        { $push: { logs: logEntry }, responseTime: new Date() },
        logOptions
      );

      const nextAmb = await handleRejection(request, session, useTransaction);
      await commitSession(sessionData);

      const io = req.app.get('io');
      if (io) {
        if (nextAmb) {
          const eta = await estimateEta(
            nextAmb.currentLocation.coordinates,
            request.location.coordinates
          );
          emitDriverRoom(io, nextAmb.driverId, 'dispatchAssigned', {
            requestId:    request._id,
            location:     request.location,
            priority:     request.priority,
            eta:          Math.round(eta / 60),
            patientName:  request.userName,
            patientPhone: request.userPhone,
          });
          io.to(`user_${request.userId}`).emit('ambulanceReassigned', {
            requestId: request._id,
            newEta:    Math.round(eta / 60),
          });
        } else {
          io.to('admins').emit('dispatchQueued', { requestId: request._id });
          io.to(`user_${request.userId}`).emit('dispatchDelayed', {
            message: 'No ambulances currently available. You are in queue.',
          });
        }
      }

      return res.status(200).json({
        success: true,
        message: 'Assignment rejected â€” searching for next ambulance',
      });
    }

    // â”€â”€ Acceptance: transition to EN_ROUTE â”€â”€
    request.status         = REQUEST_STATUS.EN_ROUTE;
    request.allocationTime = request.allocationTime || new Date();

    const saveOptions = {};
    if (useTransaction && session) {
      saveOptions.session = session;
    }
    await request.save(saveOptions);

    myAmb.status = AMBULANCE_STATUS.EN_ROUTE;
    const ambSaveOptions = {};
    if (useTransaction && session) {
      ambSaveOptions.session = session;
    }
    await myAmb.save(ambSaveOptions);

    const logUpdateOptions = { upsert: true };
    if (useTransaction && session) {
      logUpdateOptions.session = session;
    }

    await DispatchLog.findOneAndUpdate(
      { requestId: request._id },
      {
        $push: { logs: logEntry },
        responseTime: new Date(),
        acceptedAt:   new Date(),
      },
      logUpdateOptions
    );

    await commitSession(sessionData);

    const eta = await estimateEta(
      myAmb.currentLocation.coordinates,
      request.location.coordinates
    );

    const io = req.app.get('io');
    if (io) {
      io.to(`request_${request._id}`).emit('statusUpdate', {
        requestId:   request._id,
        status:      REQUEST_STATUS.EN_ROUTE,
        eta:         Math.round(eta / 60),
        ambulanceId: myAmb._id,
        timestamp:   new Date(),
      });
      io.to(`user_${request.userId}`).emit('ambulanceEnRoute', {
        requestId:        request._id,
        eta:              Math.round(eta / 60),
        etaSeconds:       eta,
        estimatedArrival: new Date(Date.now() + eta * 1000).toISOString(),
      });
    }

    res.status(200).json({ success: true, data: request, message: 'Assignment accepted' });
  } catch (err) {
    await abortSession(sessionData);
    next(err);
  }
};

// â”€â”€â”€ GET /api/dispatch/active â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * @desc  Get current active request for the authenticated citizen
 * @route GET /api/dispatch/active
 * @access Private (Citizen)
 */
exports.getActive = async (req, res, next) => {
  try {
    const request = await EmergencyRequest.findOne({
      userId: req.user._id,
      status: { $in: [REQUEST_STATUS.PENDING, REQUEST_STATUS.ASSIGNED, REQUEST_STATUS.EN_ROUTE] },
    })
      .populate('assignedAmbulanceId', 'plateNumber driverId currentLocation')
      .lean();

    if (!request) {
      return res.status(200).json({ success: true, data: null, message: 'No active request' });
    }

    let eta = null;
    const ambLoc = request.assignedAmbulanceId?.currentLocation?.coordinates;
    if (ambLoc) {
      eta = await estimateEta(ambLoc, request.location.coordinates);
    }

    res.status(200).json({
      success: true,
      data: {
        ...request,
        eta:       eta !== null ? Math.round(eta / 60) : null,
        etaSeconds: eta,
      },
    });
  } catch (err) {
    next(err);
  }
};

// â”€â”€â”€ GET /api/dispatch/assignments â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * @desc  Get active assignments for the current driver
 * @route GET /api/dispatch/assignments
 * @access Private (Driver)
 */
exports.getAssignments = async (req, res, next) => {
  try {
    const amb = await Ambulance.findOne({ driverId: req.user._id }).lean();
    if (!amb) {
      return res.status(200).json({
        success: true,
        count: 0,
        data: [],
        message: 'No ambulance is registered for this driver yet',
      });
    }

    const requests = await EmergencyRequest.find({
      assignedAmbulanceId: amb._id,
      status: { $in: [REQUEST_STATUS.ASSIGNED, REQUEST_STATUS.EN_ROUTE] },
    })
      .populate('assignedHospital', 'name phone')
      .sort('-requestTime')
      .lean();

    const withEta = await Promise.all(requests.map(async (r) => {
      const doc = { ...r };
      if (r.location?.coordinates && amb.currentLocation?.coordinates) {
        const eta = await estimateEta(amb.currentLocation.coordinates, r.location.coordinates);
        doc.eta = Math.round(eta / 60);
        doc.etaSeconds = eta;
      }
      return doc;
    }));

    res.status(200).json({ success: true, count: withEta.length, data: withEta });
  } catch (err) {
    next(err);
  }
};

// â”€â”€â”€ PATCH /api/dispatch/:id/track â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * @desc  Driver updates position / status while en route
 * @route PATCH /api/dispatch/:id/track
 * @access Private (Driver)
 */
exports.track = async (req, res, next) => {
  let sessionData;

  try {
    sessionData = await startTransactionSession();
    const { session, useTransaction } = sessionData;
    const { id }                         = req.params;
    const { longitude, latitude, status, notes } = req.body;

    const request = await EmergencyRequest.findById(id).session(session);
    if (!request) throw new AppError('Request not found', 404);

    const amb = await Ambulance.findOne({ driverId: req.user._id }).session(session);
    if (!amb || String(request.assignedAmbulanceId) !== String(amb._id)) {
      throw new AppError('Not authorised to track this request', 403);
    }

    // â”€â”€ Status transition â”€â”€
    if (status) {
      if (!REQUEST_STATUS_VALUES.includes(status)) {
        throw new AppError('Invalid status value', 400);
      }

      const validTransitions = {
        [REQUEST_STATUS.ASSIGNED]: [REQUEST_STATUS.EN_ROUTE, REQUEST_STATUS.COMPLETED],
        [REQUEST_STATUS.EN_ROUTE]: [REQUEST_STATUS.COMPLETED],
      };

      if (
        validTransitions[request.status] &&
        !validTransitions[request.status].includes(status)
      ) {
        throw new AppError(`Cannot transition from ${request.status} to ${status}`, 400);
      }

      request.status = status;

      if (status === REQUEST_STATUS.COMPLETED) {
        request.completionTime = new Date();
        amb.status             = AMBULANCE_STATUS.AVAILABLE;
        await amb.save({ session });
      }
    }

    // â”€â”€ Location update â”€â”€
    let locationChanged = false;
    if (longitude != null && latitude != null) {
      const lng = parseFloat(longitude);
      const lat = parseFloat(latitude);
      if (isNaN(lng) || isNaN(lat) || lng < -180 || lng > 180 || lat < -90 || lat > 90) {
        throw new AppError('Invalid coordinates', 400);
      }

      if (amb.currentLocation?.coordinates) {
        const [oldLng, oldLat] = amb.currentLocation.coordinates;
        locationChanged = haversineDistance(lat, lng, oldLat, oldLng) > 50;
      } else {
        locationChanged = true;
      }

      if (locationChanged) {
        amb.currentLocation = { type: 'Point', coordinates: [lng, lat] };
        await amb.save({ session });
      }
    }

    // â”€â”€ Audit log â”€â”€
    if (notes) {
      await DispatchLog.findOneAndUpdate(
        { requestId: request._id },
        {
          $push: {
            logs: {
              message:  String(notes).trim().slice(0, 500),
              driverId: req.user._id,
              location: amb.currentLocation?.coordinates,
            },
          },
        },
        { session, upsert: true }
      );
    }

    await request.save({ session });
    await commitSession(sessionData);

    const io = req.app.get('io');
    if (request.status === REQUEST_STATUS.COMPLETED && io) {
      await processQueuedAssignment(io);
    }

    // â”€â”€ Socket notifications â”€â”€
    if (io) {
      if (status) {
        io.to(`request_${request._id}`).emit('statusUpdate', {
          requestId: request._id,
          status:    request.status,
          timestamp: new Date(),
        });
      }

      if (locationChanged && longitude != null) {
        const [lng, lat] = amb.currentLocation.coordinates;
        io.to(`request_${request._id}`).emit('locationUpdate', {
          ambulanceId: amb._id,
          coordinates: [lng, lat],
          timestamp:   new Date(),
        });

        if (request.location?.coordinates) {
          const eta = await estimateEta([lng, lat], request.location.coordinates);
          io.to(`user_${request.userId}`).emit('etaUpdate', {
            requestId:        request._id,
            eta:              Math.round(eta / 60),
            etaSeconds:       eta,
            estimatedArrival: new Date(Date.now() + eta * 1000).toISOString(),
          });
        }
      }
    }

    res.status(200).json({ success: true, data: request });
  } catch (err) {
    if (sessionData) await abortSession(sessionData);
    next(err);
  } finally {
    if (sessionData?.session) sessionData.session.endSession();
  }
};

// â”€â”€â”€ DELETE /api/dispatch/:id â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * @desc  Citizen cancels their pending/assigned request
 * @route DELETE /api/dispatch/:id
 * @access Private (Citizen)
 */
exports.cancelRequest = async (req, res, next) => {
  let sessionData;

  try {
    sessionData = await startTransactionSession();
    const { session, useTransaction } = sessionData;
    const request = await EmergencyRequest.findById(req.params.id).session(session);
    if (!request) throw new AppError('Request not found', 404);

    if (String(request.userId) !== String(req.user._id)) {
      throw new AppError('Not authorised to cancel this request', 403);
    }

    const cancellableStatuses = [REQUEST_STATUS.PENDING, REQUEST_STATUS.ASSIGNED];
    if (!cancellableStatuses.includes(request.status)) {
      throw new AppError('Cannot cancel a request that is already EN_ROUTE or completed', 400);
    }

    let cancelledAmbulance = null;
    if (request.assignedAmbulanceId) {
      cancelledAmbulance = await Ambulance.findById(request.assignedAmbulanceId).session(session);
      if (cancelledAmbulance) {
        cancelledAmbulance.status = AMBULANCE_STATUS.AVAILABLE;
        await cancelledAmbulance.save({ session });
      }
    }

    request.status = REQUEST_STATUS.CANCELLED;
    await request.save({ session });

    await DispatchLog.findOneAndUpdate(
      { requestId: request._id },
      {
        $push: { logs: { message: 'Request cancelled by citizen' } },
        status: 'CANCELLED',
      },
      { session, upsert: true }
    );

    await commitSession(sessionData);

    const io = req.app.get('io');
    if (io) {
      if (cancelledAmbulance?.driverId) {
        io.to(`driver_${cancelledAmbulance.driverId}`).emit('requestCancelled', {
          requestId: request._id,
        });
      }
      io.to('admins').emit('requestCancelled', {
        requestId: request._id,
        userId:    req.user._id,
      });
      io.to(`user_${req.user._id}`).emit('requestCancelled', {
        requestId: request._id,
      });
    }

    if (cancelledAmbulance) {
      await processQueuedAssignment(io);
    }

    res.status(200).json({ success: true, message: 'Request cancelled successfully' });
  } catch (err) {
    if (sessionData) await abortSession(sessionData);
    next(err);
  } finally {
    if (sessionData?.session) sessionData.session.endSession();
  }
};

