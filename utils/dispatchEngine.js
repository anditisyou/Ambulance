'use strict';

/**
 * Dispatch Engine
 * ───────────────
 * Responsible for finding the best available ambulance for an emergency request
 * and performing the DB writes that constitute an "allocation" — all within a
 * caller-supplied Mongoose session so the entire operation is atomic.
 *
 * Design decisions
 * ─────────────────
 * 1. Proximity-first: nearest available ambulance wins.  For high-priority
 *    (CRITICAL) requests we widen the search radius automatically.
 * 2. All writes are performed inside the session passed by the controller —
 *    this engine never commits/aborts a transaction itself.
 * 3. handleRejection re-uses allocateAmbulance but excludes the rejecting
 *    ambulance so the same vehicle is never offered twice.
 */

const Ambulance         = require('../models/Ambulance');
const DispatchLog       = require('../models/DispatchLog');
const EmergencyRequest  = require('../models/EmergencyRequest');
const logger            = require('../utils/logger');
const { haversineDistance } = require('../utils/haversine');
const { getETA } = require('./etaCalculator');
const { AMBULANCE_STATUS, REQUEST_STATUS, REQUEST_PRIORITY, SLA_TARGET_SECONDS, SLA_STATUS } = require('./constants');

// ─── Constants ────────────────────────────────────────────────────────────────

/** Search radii by priority (metres). */
const SEARCH_RADIUS = {
  [REQUEST_PRIORITY.CRITICAL]: 100_000, // 100 km
  [REQUEST_PRIORITY.HIGH]:      50_000, //  50 km
  [REQUEST_PRIORITY.MEDIUM]:    30_000, //  30 km
  [REQUEST_PRIORITY.LOW]:       20_000, //  20 km
};

const DEFAULT_RADIUS = 30_000;

/** Priority weights for ambulance scoring (higher = more urgent). */
const PRIORITY_WEIGHT = {
  [REQUEST_PRIORITY.LOW]: 0,
  [REQUEST_PRIORITY.MEDIUM]: 1,
  [REQUEST_PRIORITY.HIGH]: 2,
  [REQUEST_PRIORITY.CRITICAL]: 3,
};

/**
 * Intelligent ambulance selection with optimized scoring algorithm.
 * Factors: distance (40%), ETA (30%), priority compatibility (20%), hospital compatibility (10%)
 */
const scoreAmbulance = async (ambulance, request, hospital) => {
  let score = 0;

  // Distance factor (lower distance = higher score) - 40%
  const distance = haversineDistance(
    request.location.coordinates[1], request.location.coordinates[0],
    ambulance.currentLocation.coordinates[1], ambulance.currentLocation.coordinates[0]
  );
  const maxDistance = 50000; // 50km
  const distanceScore = Math.max(0, (maxDistance - distance) / maxDistance) * 0.4;
  score += distanceScore;

  // Traffic-adjusted ETA (lower ETA = higher score) - 30%
  try {
    const eta = await getETA(ambulance.currentLocation.coordinates, request.location.coordinates);
    const maxEta = 1800; // 30 minutes
    const etaScore = Math.max(0, (maxEta - eta) / maxEta) * 0.3;
    score += etaScore;
  } catch (err) {
    // Fallback to distance-based ETA approximation
    const distanceBasedEta = distance / 500; // Rough 500m/minute estimate
    const etaScore = Math.max(0, (1800 - distanceBasedEta) / 1800) * 0.3;
    score += etaScore;
  }

  // Priority compatibility (higher priority requests prefer faster response) - 20%
  const priorityWeight = PRIORITY_WEIGHT[request.priority] || 0;
  const priorityScore = (priorityWeight / 3) * 0.2; // Normalize to 0-1
  score += priorityScore;

  // Hospital compatibility (reduced weight) - 10%
  if (hospital?.location?.coordinates) {
    try {
      const hospitalDistance = haversineDistance(
        hospital.location.coordinates[1], hospital.location.coordinates[0],
        ambulance.currentLocation.coordinates[1], ambulance.currentLocation.coordinates[0]
      );
      const hospitalScore = hospitalDistance < 30000 ? 0.1 : 0.05; // Bonus if within 30km
      score += hospitalScore;
    } catch (err) {
      score += 0.05; // Neutral
    }
  } else {
    score += 0.05; // Neutral score if no hospital constraint
  }

  return { ambulance, score };
};

const getSlaStatus = (request) => {
  const targetSeconds = SLA_TARGET_SECONDS[request.priority] ?? SLA_TARGET_SECONDS.MEDIUM;
  const requestAgeSeconds = Math.max(0, (Date.now() - new Date(request.requestTime).getTime()) / 1000);

  if (requestAgeSeconds > targetSeconds) return SLA_STATUS.BREACHED;
  if (requestAgeSeconds > targetSeconds * 0.75) return SLA_STATUS.AT_RISK;
  return SLA_STATUS.ON_TRACK;
};

const getNextQueuedRequest = async (session) => {
  const [queuedRequest] = await EmergencyRequest.aggregate([
    { $match: { status: REQUEST_STATUS.PENDING } },
    {
      $addFields: {
        priorityRank: {
          $switch: {
            branches: [
              { case: { $eq: ['$priority', REQUEST_PRIORITY.CRITICAL] }, then: 3 },
              { case: { $eq: ['$priority', REQUEST_PRIORITY.HIGH] }, then: 2 },
              { case: { $eq: ['$priority', REQUEST_PRIORITY.MEDIUM] }, then: 1 },
              { case: { $eq: ['$priority', REQUEST_PRIORITY.LOW] }, then: 0 },
            ],
            default: 0,
          },
        },
      },
    },
    { $sort: { priorityRank: -1, requestTime: 1 } },
    { $limit: 1 },
  ]).session(session).exec();

  return queuedRequest || null;
};

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Find the nearest available ambulance within the priority-based radius.
 *
 * @param {{ type: string, coordinates: [number, number] }} location - GeoJSON Point
 * @param {string}   priority  - REQUEST_PRIORITY value
 * @param {string[]} excludeIds - Ambulance _id strings to skip (rejected vehicles)
 * @param {import('mongoose').ClientSession} session
 * @returns {Promise<import('mongoose').Document|null>}
 */
const findNearest = async (location, priority, excludeIds, session, hospital = null) => {
  // Validate coordinates BEFORE processing
  if (!location?.coordinates || !Array.isArray(location.coordinates) || location.coordinates.length !== 2) {
    logger.error('Invalid location coordinates: missing or malformed', { location });
    return null;
  }
  
  const [lng, lat] = location.coordinates;
  if (typeof lng !== 'number' || typeof lat !== 'number' || 
      lng < -180 || lng > 180 || lat < -90 || lat > 90 ||
      isNaN(lng) || isNaN(lat)) {
    logger.error('Invalid coordinate values', { lng, lat });
    return null;
  }

  const maxDistance = SEARCH_RADIUS[priority] ?? DEFAULT_RADIUS;

  const filter = {
    status: AMBULANCE_STATUS.AVAILABLE,
    currentLocation: {
      $near: {
        $geometry: location,
        $maxDistance: maxDistance,
      },
    },
  };

  if (excludeIds && excludeIds.length > 0) {
    filter._id = { $nin: excludeIds };
  }

  const candidates = await Ambulance.find(filter)
    .populate('driverId', 'name phone')
    .session(session)
    .limit(5); // Reduced from 10 to 5 for better performance

  if (!candidates.length) {
    const shouldUseFallback = priority === REQUEST_PRIORITY.CRITICAL;
    if (!shouldUseFallback) {
      logger.warn('No nearby ambulance available; request should queue instead of assigning a remote vehicle.', {
        maxDistance,
        excludeIds,
        priority,
      });
      return null;
    }

    const fallbackFilter = {
      status: AMBULANCE_STATUS.AVAILABLE,
      $or: [
        { currentLocation: { $exists: false } },
        { 'currentLocation.coordinates': { $exists: false } },
        { 'currentLocation.coordinates': [] },
      ],
    };

    if (excludeIds && excludeIds.length > 0) {
      fallbackFilter._id = { $nin: excludeIds };
    }

    logger.warn('Critical request: no nearby ambulance found within radius. Checking locationless vehicles as fallback.', {
      maxDistance,
      excludeIds,
    });

    const fallbackCandidates = await Ambulance.find(fallbackFilter)
      .populate('driverId', 'name phone')
      .session(session)
      .limit(5);

    if (fallbackCandidates.length) {
      const requestStub = { location: { coordinates: location }, priority };
      const scored = await Promise.all(fallbackCandidates.map(amb => scoreAmbulance(amb, requestStub, hospital)));
      scored.sort((a, b) => b.score - a.score);
      const best = scored[0].ambulance;

      const updated = await Ambulance.findOneAndUpdate(
        { _id: best._id, status: AMBULANCE_STATUS.AVAILABLE },
        { status: AMBULANCE_STATUS.ASSIGNED },
        { session, new: true }
      ).populate('driverId', 'name phone');

      if (updated) {
        logger.info('Allocated locationless or invalid-location ambulance as fallback for critical request.', {
          ambulanceId: updated._id.toString(),
          driverId:    updated.driverId?._id?.toString() || updated.driverId,
        });
        return updated;
      }
    }

    const broadFilter = {
      status: AMBULANCE_STATUS.AVAILABLE,
    };

    if (excludeIds && excludeIds.length > 0) {
      broadFilter._id = { $nin: excludeIds };
    }

    logger.warn('Critical request fallback: no locationless ambulance found, assigning any available ambulance regardless of distance.', {
      excludeIds,
    });

    const broadCandidates = await Ambulance.find(broadFilter)
      .populate('driverId', 'name phone')
      .session(session)
      .limit(5);

    if (broadCandidates.length) {
      const requestStub = { location: { coordinates: location }, priority };
      const scored = await Promise.all(broadCandidates.map(amb => scoreAmbulance(amb, requestStub, hospital)));
      scored.sort((a, b) => b.score - a.score);
      const best = scored[0].ambulance;

      const updated = await Ambulance.findOneAndUpdate(
        { _id: best._id, status: AMBULANCE_STATUS.AVAILABLE },
        { status: AMBULANCE_STATUS.ASSIGNED },
        { session, new: true }
      ).populate('driverId', 'name phone');

      if (updated) return updated;
    }

    return null;
  }

  const requestStub = { location: { coordinates: location }, priority };
  const scored = await Promise.all(candidates.map(amb => scoreAmbulance(amb, requestStub, hospital)));
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0].ambulance;

  const updated = await Ambulance.findOneAndUpdate(
    { _id: best._id, status: AMBULANCE_STATUS.AVAILABLE },
    { status: AMBULANCE_STATUS.ASSIGNED },
    { session, new: true }
  ).populate('driverId', 'name phone');

  if (updated) return updated;

  for (let i = 1; i < scored.length; i++) {
    const next = scored[i].ambulance;
    const updatedNext = await Ambulance.findOneAndUpdate(
      { _id: next._id, status: AMBULANCE_STATUS.AVAILABLE },
      { status: AMBULANCE_STATUS.ASSIGNED },
      { session, new: true }
    ).populate('driverId', 'name phone');

    if (updatedNext) return updatedNext;
  }

  return null;
};

/**
 * Write the allocation: mark ambulance ASSIGNED, update request, create/update DispatchLog.
 *
 * @param {import('mongoose').Document} request
 * @param {import('mongoose').Document} ambulance
 * @param {import('mongoose').ClientSession} session
 */
const writeAllocation = async (request, ambulance, session) => {
  // Ambulance is already assigned atomically in findNearest

  // 2. Update the request
  request.status              = REQUEST_STATUS.ASSIGNED;
  request.assignedAmbulanceId = ambulance._id;
  request.allocationTime      = new Date();
  await request.save({ session });

  // 3. Create/update audit log
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
        logs: {
          message:  `Allocated ambulance ${ambulance.plateNumber} (priority: ${request.priority})`,
          timestamp: new Date(),
        },
      },
    },
    { session, upsert: true, new: true }
  );
};

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Find and allocate the nearest available ambulance to a request.
 * Returns the ambulance document if allocation succeeded, null otherwise.
 *
 * @param {import('mongoose').Document} request  - Unsaved or newly-created EmergencyRequest
 * @param {import('mongoose').ClientSession} session
 * @returns {Promise<import('mongoose').Document|null>} The allocated ambulance, or null
 */
const allocateAmbulance = async (request, session, hospital = null) => {
  logger.info('Starting ambulance allocation', {
    requestId: request._id.toString(),
    priority: request.priority,
    location: request.location.coordinates,
    hospitalId: hospital?._id?.toString()
  });

  const ambulance = await findNearest(
    request.location,
    request.priority,
    [],
    session,
    hospital
  );

  if (!ambulance) {
    logger.warn('No ambulance available within search radius for request allocation', {
      requestId: request._id.toString(),
      priority: request.priority,
      slaStatus: getSlaStatus(request),
      requestAgeSeconds: Math.round((Date.now() - new Date(request.requestTime).getTime()) / 1000),
    });
    return null;
  }

  logger.info('Ambulance allocated successfully', {
    requestId: request._id.toString(),
    ambulanceId: ambulance._id.toString(),
    driverId: ambulance.driverId?.toString(),
  });

  await writeAllocation(request, ambulance, session);
  return ambulance;
};

/**
 * Handle a driver rejection by freeing their ambulance and finding the next best.
 * The rejecting ambulance is excluded from the new search.
 *
 * @param {import('mongoose').Document} request
 * @param {import('mongoose').ClientSession} session
 * @returns {Promise<import('mongoose').Document|null>} New ambulance, or null
 */
const handleRejection = async (request, session) => {
  // Collect all previously-rejected ambulance IDs from the dispatch log
  const log = await DispatchLog.findOne({ requestId: request._id })
    .session(session)
    .lean();

  const previousAmbulanceIds = log
    ? [log.ambulanceId, ...(log.rejectedAmbulances || [])].filter(Boolean)
    : [];

  // Reset request to PENDING while we search
  const prevAmbulanceId       = request.assignedAmbulanceId;
  request.status              = REQUEST_STATUS.PENDING;
  request.assignedAmbulanceId = undefined;
  await request.save({ session });

  // Free the rejecting ambulance
  if (prevAmbulanceId) {
    await Ambulance.findByIdAndUpdate(
      prevAmbulanceId,
      { status: AMBULANCE_STATUS.AVAILABLE },
      { session }
    );

    // Record the rejection in the dispatch log
    await DispatchLog.findOneAndUpdate(
      { requestId: request._id },
      {
        $push: {
          rejectedAmbulances: prevAmbulanceId,
          logs: {
            message:  `Ambulance ${prevAmbulanceId} rejected assignment`,
            timestamp: new Date(),
          },
        },
      },
      { session, upsert: true }
    );
  }

  const nextAmbulance = await findNearest(
    request.location,
    request.priority,
    previousAmbulanceIds.map(String),
    session
  );

  if (!nextAmbulance) return null;

  await writeAllocation(request, nextAmbulance, session);
  return nextAmbulance;
};

/**
 * Try to allocate the highest-priority pending request when an ambulance becomes available.
 * Returns the allocated request and ambulance, or null if nothing was assigned.
 *
 * @param {import('mongoose').ClientSession} session
 * @returns {Promise<{request: import('mongoose').Document, ambulance: import('mongoose').Document}|null>}
 */
const allocateQueuedRequest = async (session) => {
  const queuedRequest = await getNextQueuedRequest(session);
  if (!queuedRequest) return null;

  const request = await EmergencyRequest.findOne({
    _id: queuedRequest._id,
    status: REQUEST_STATUS.PENDING,
  }).session(session);

  if (!request) return null;

  const ambulance = await allocateAmbulance(request, session);
  if (!ambulance) return null;

  return { request, ambulance };
};

module.exports = { allocateAmbulance, handleRejection, allocateQueuedRequest };
