'use strict';

const mongoose         = require('mongoose');
const EmergencyRequest = require('../models/EmergencyRequest');
const Ambulance        = require('../models/Ambulance');
const DispatchLog      = require('../models/DispatchLog');
const AppError         = require('../utils/AppError');
const { haversineDistance } = require('../utils/haversine');
const {
  REQUEST_PRIORITY,
  REQUEST_PRIORITY_VALUES, // FIX: use the array, not the object, for .includes()
  REQUEST_TYPES,
  REQUEST_TYPES_VALUES,    // FIX: same
  REQUEST_STATUS,
  REQUEST_STATUS_VALUES,
  AMBULANCE_STATUS,
} = require('../utils/constants');

// ─── Internal helpers ─────────────────────────────────────────────────────────

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

/**
 * Naive ETA estimate (seconds) based on straight-line distance at 40 km/h.
 * Replace with a real routing engine (OSRM / Google Maps) in production.
 *
 * @param {[number,number]} from - [lng, lat]
 * @param {[number,number]} to   - [lng, lat]
 * @returns {number} Estimated seconds
 */
const estimateEta = (from, to) => {
  const distM   = haversineDistance(from[1], from[0], to[1], to[0]);
  const speedMs = (40 * 1000) / 3600; // 40 km/h in m/s
  return Math.round(distM / speedMs);
};

// ─── POST /api/dispatch/request ───────────────────────────────────────────────

/**
 * @desc  Citizen raises a new SOS emergency request
 * @route POST /api/dispatch/request
 * @access Private (Citizen)
 */
exports.newRequest = async (req, res, next) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { latitude, longitude, priority, type, description } = req.body;

    // ── Coordinate validation ──
    if (latitude == null || longitude == null) {
      throw new AppError('latitude and longitude are required', 400);
    }
    const locLng = parseFloat(longitude);
    const locLat = parseFloat(latitude);
    if (
      isNaN(locLng) || isNaN(locLat) ||
      locLng < -180 || locLng > 180 ||
      locLat < -90  || locLat > 90
    ) {
      throw new AppError('Invalid coordinates', 400);
    }

    // ── Block duplicate active requests ──
    const existingActive = await EmergencyRequest.findOne({
      userId: req.user._id,
      status: { $in: [REQUEST_STATUS.PENDING, REQUEST_STATUS.ASSIGNED, REQUEST_STATUS.EN_ROUTE] },
    }).session(session).lean();

    if (existingActive) {
      throw new AppError('You already have an active emergency request', 400);
    }

    const location = { type: 'Point', coordinates: [locLng, locLat] };

    // FIX: use REQUEST_PRIORITY_VALUES array (not the object) for .includes()
    const prio = REQUEST_PRIORITY_VALUES.includes(priority?.toUpperCase())
      ? priority.toUpperCase()
      : REQUEST_PRIORITY.MEDIUM;

    // FIX: use REQUEST_TYPES_VALUES array (not the object) for .includes()
    const reqType = REQUEST_TYPES_VALUES.includes(type)
      ? type
      : REQUEST_TYPES.MEDICAL;

    const desc = description ? String(description).trim().slice(0, 500) : '';

    // ── Create request in transaction ──
    const [request] = await EmergencyRequest.create(
      [{
        userId:      req.user._id,
        userName:    req.user.name,
        userPhone:   req.user.phone,
        location,
        priority:    prio,
        status:      REQUEST_STATUS.PENDING,
        type:        reqType,
        description: desc,
        requestTime: new Date(),
      }],
      { session }
    );

    // ── Auto-dispatch nearest ambulance ──
    const ambulance = await findNearestAmbulance(location, session);
    if (ambulance) {
      await assignAmbulance(request, ambulance, session);
    }

    await session.commitTransaction();

    // ── Real-time notifications ──
    const io = req.app.get('io');
    if (io) {
      if (ambulance) {
        const eta = estimateEta(
          ambulance.currentLocation.coordinates,
          location.coordinates
        );

        io.to(`driver_${ambulance.driverId}`).emit('dispatchAssigned', {
          requestId:    request._id,
          location:     request.location,
          priority:     request.priority,
          eta:          Math.round(eta / 60),
          etaSeconds:   eta,
          patientName:  req.user.name,
          patientPhone: req.user.phone,
        });

        io.to(`user_${req.user._id}`).emit('ambulanceAssigned', {
          ambulanceId:       ambulance._id,
          ambulancePlate:    ambulance.plateNumber,
          eta:               Math.round(eta / 60),
          etaSeconds:        eta,
          estimatedArrival:  new Date(Date.now() + eta * 1000).toISOString(),
        });

        io.to('admins').emit('dispatchAllocated', {
          requestId:   request._id,
          ambulanceId: ambulance._id,
          priority:    request.priority,
        });
      } else {
        io.to('admins').emit('dispatchQueued', {
          requestId: request._id,
          location:  request.location,
          priority:  request.priority,
          timestamp: new Date(),
        });

        io.to(`user_${req.user._id}`).emit('dispatchQueued', {
          message: 'No ambulances currently available. You are in queue.',
        });
      }
    }

    res.status(201).json({
      success:   true,
      data:      request,
      allocated: !!ambulance,
    });
  } catch (err) {
    await session.abortTransaction();
    next(err);
  } finally {
    session.endSession();
  }
};

// ─── PUT /api/dispatch/:id/response ──────────────────────────────────────────

/**
 * @desc  Driver accepts or rejects their dispatch assignment
 * @route PUT /api/dispatch/:id/response
 * @access Private (Driver)
 */
exports.driverResponse = async (req, res, next) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { accept } = req.body;
    if (typeof accept !== 'boolean') {
      throw new AppError('"accept" must be a boolean', 400);
    }

    const request = await EmergencyRequest.findById(req.params.id).session(session);
    if (!request) throw new AppError('Request not found', 404);

    if (request.status !== REQUEST_STATUS.ASSIGNED) {
      throw new AppError('This request is no longer available for response', 400);
    }

    const myAmb = await Ambulance.findOne({ driverId: req.user._id }).session(session);
    if (!myAmb) throw new AppError('Ambulance not found for this driver', 404);

    if (String(request.assignedAmbulanceId) !== String(myAmb._id)) {
      throw new AppError('Not your assignment', 403);
    }

    const logEntry = {
      message:  accept ? 'Driver accepted assignment' : 'Driver rejected assignment',
      driverId: req.user._id,
    };

    if (!accept) {
      // ── Rejection: free ambulance and try to reassign ──
      myAmb.status = AMBULANCE_STATUS.AVAILABLE;
      await myAmb.save({ session });

      request.status              = REQUEST_STATUS.PENDING;
      request.assignedAmbulanceId = undefined;
      await request.save({ session });

      await DispatchLog.findOneAndUpdate(
        { requestId: request._id },
        { $push: { logs: logEntry }, responseTime: new Date() },
        { session, upsert: true }
      );

      // Attempt reassignment to next nearest
      const nextAmb = await findNearestAmbulance(request.location, session);
      if (nextAmb) {
        await assignAmbulance(request, nextAmb, session);
      }

      await session.commitTransaction();

      const io = req.app.get('io');
      if (io) {
        if (nextAmb) {
          const eta = estimateEta(
            nextAmb.currentLocation.coordinates,
            request.location.coordinates
          );
          io.to(`driver_${nextAmb.driverId}`).emit('dispatchAssigned', {
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
        message: 'Assignment rejected — searching for next ambulance',
      });
    }

    // ── Acceptance: transition to EN_ROUTE ──
    request.status         = REQUEST_STATUS.EN_ROUTE;
    request.allocationTime = request.allocationTime || new Date();
    await request.save({ session });

    myAmb.status = AMBULANCE_STATUS.ENROUTE;
    await myAmb.save({ session });

    await DispatchLog.findOneAndUpdate(
      { requestId: request._id },
      {
        $push: { logs: logEntry },
        responseTime: new Date(),
        acceptedAt:   new Date(),
      },
      { session, upsert: true }
    );

    await session.commitTransaction();

    const eta = estimateEta(
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
    await session.abortTransaction();
    next(err);
  } finally {
    session.endSession();
  }
};

// ─── GET /api/dispatch/active ─────────────────────────────────────────────────

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
      eta = estimateEta(ambLoc, request.location.coordinates);
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

// ─── GET /api/dispatch/assignments ────────────────────────────────────────────

/**
 * @desc  Get active assignments for the current driver
 * @route GET /api/dispatch/assignments
 * @access Private (Driver)
 */
exports.getAssignments = async (req, res, next) => {
  try {
    const amb = await Ambulance.findOne({ driverId: req.user._id }).lean();
    if (!amb) throw new AppError('Ambulance not registered for this driver', 404);

    const requests = await EmergencyRequest.find({
      assignedAmbulanceId: amb._id,
      status: { $in: [REQUEST_STATUS.ASSIGNED, REQUEST_STATUS.EN_ROUTE] },
    })
      .sort('-requestTime')
      .lean();

    const withEta = requests.map((r) => {
      const doc = { ...r };
      if (r.location?.coordinates && amb.currentLocation?.coordinates) {
        const eta   = estimateEta(amb.currentLocation.coordinates, r.location.coordinates);
        doc.eta       = Math.round(eta / 60);
        doc.etaSeconds = eta;
      }
      return doc;
    });

    res.status(200).json({ success: true, count: withEta.length, data: withEta });
  } catch (err) {
    next(err);
  }
};

// ─── PATCH /api/dispatch/:id/track ────────────────────────────────────────────

/**
 * @desc  Driver updates position / status while en route
 * @route PATCH /api/dispatch/:id/track
 * @access Private (Driver)
 */
exports.track = async (req, res, next) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { id }                         = req.params;
    const { longitude, latitude, status, notes } = req.body;

    const request = await EmergencyRequest.findById(id).session(session);
    if (!request) throw new AppError('Request not found', 404);

    const amb = await Ambulance.findOne({ driverId: req.user._id }).session(session);
    if (!amb || String(request.assignedAmbulanceId) !== String(amb._id)) {
      throw new AppError('Not authorised to track this request', 403);
    }

    // ── Status transition ──
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

    // ── Location update ──
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

    // ── Audit log ──
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
    await session.commitTransaction();

    // ── Socket notifications ──
    const io = req.app.get('io');
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
          const eta = estimateEta([lng, lat], request.location.coordinates);
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
    await session.abortTransaction();
    next(err);
  } finally {
    session.endSession();
  }
};

// ─── DELETE /api/dispatch/:id ─────────────────────────────────────────────────

/**
 * @desc  Citizen cancels their pending/assigned request
 * @route DELETE /api/dispatch/:id
 * @access Private (Citizen)
 */
exports.cancelRequest = async (req, res, next) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const request = await EmergencyRequest.findById(req.params.id).session(session);
    if (!request) throw new AppError('Request not found', 404);

    if (String(request.userId) !== String(req.user._id)) {
      throw new AppError('Not authorised to cancel this request', 403);
    }

    const cancellableStatuses = [REQUEST_STATUS.PENDING, REQUEST_STATUS.ASSIGNED];
    if (!cancellableStatuses.includes(request.status)) {
      throw new AppError('Cannot cancel a request that is already EN_ROUTE or completed', 400);
    }

    // Free the ambulance if one was assigned
    if (request.assignedAmbulanceId) {
      await Ambulance.findByIdAndUpdate(
        request.assignedAmbulanceId,
        { status: AMBULANCE_STATUS.AVAILABLE },
        { session }
      );
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

    await session.commitTransaction();

    const io = req.app.get('io');
    if (io) {
      if (request.assignedAmbulanceId) {
        io.to(`ambulance_${request.assignedAmbulanceId}`).emit('requestCancelled', {
          requestId: request._id,
        });
      }
      io.to('admins').emit('requestCancelled', {
        requestId: request._id,
        userId:    req.user._id,
      });
    }

    res.status(200).json({ success: true, message: 'Request cancelled successfully' });
  } catch (err) {
    await session.abortTransaction();
    next(err);
  } finally {
    session.endSession();
  }
};
