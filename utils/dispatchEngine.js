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

const Ambulance        = require('../models/Ambulance');
const DispatchLog      = require('../models/DispatchLog');
const { AMBULANCE_STATUS, REQUEST_STATUS, REQUEST_PRIORITY } = require('./constants');

// ─── Constants ────────────────────────────────────────────────────────────────

/** Search radii by priority (metres). */
const SEARCH_RADIUS = {
  [REQUEST_PRIORITY.CRITICAL]: 100_000, // 100 km
  [REQUEST_PRIORITY.HIGH]:      50_000, //  50 km
  [REQUEST_PRIORITY.MEDIUM]:    30_000, //  30 km
  [REQUEST_PRIORITY.LOW]:       20_000, //  20 km
};

const DEFAULT_RADIUS = 30_000;

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
const findNearest = async (location, priority, excludeIds, session) => {
  const maxDistance = SEARCH_RADIUS[priority] ?? DEFAULT_RADIUS;

  const filter = {
    status: AMBULANCE_STATUS.AVAILABLE,
    currentLocation: {
      $near: {
        $geometry:    location,
        $maxDistance: maxDistance,
      },
    },
  };

  if (excludeIds && excludeIds.length > 0) {
    filter._id = { $nin: excludeIds };
  }

  return Ambulance.findOne(filter).populate('driverId', 'name phone').session(session);
};

/**
 * Write the allocation: mark ambulance ASSIGNED, update request, create/update DispatchLog.
 *
 * @param {import('mongoose').Document} request
 * @param {import('mongoose').Document} ambulance
 * @param {import('mongoose').ClientSession} session
 */
const writeAllocation = async (request, ambulance, session) => {
  // 1. Lock the ambulance
  ambulance.status = AMBULANCE_STATUS.ASSIGNED;
  await ambulance.save({ session });

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
const allocateAmbulance = async (request, session) => {
  const ambulance = await findNearest(
    request.location,
    request.priority,
    [],
    session
  );

  if (!ambulance) return null;

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

module.exports = { allocateAmbulance, handleRejection };
