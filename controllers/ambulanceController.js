'use strict';

const mongoose    = require('mongoose');
const Ambulance  = require('../models/Ambulance');
const AppError   = require('../utils/AppError');
const { haversineDistance } = require('../utils/haversine');

const emitDriverRoom = (io, driverId, event, payload) => {
  if (!io || !driverId) return;
  const target = String(driverId);
  io.to(`driver_${target}`).emit(event, payload);
  io.to(`user_${target}`).emit(event, payload);
};

const estimateEta = (from, to) => {
  const distM = haversineDistance(from[1], from[0], to[1], to[0]);
  const speedMs = (40 * 1000) / 3600;
  return Math.round(distM / speedMs);
};

const {
  AMBULANCE_STATUS,
  AMBULANCE_STATUS_VALUES,
  AMBULANCE_TRANSITIONS,
  ROLES,
} = require('../utils/constants');
const { allocateQueuedRequest } = require('../utils/dispatchEngine');

// ─── POST /api/ambulances ─────────────────────────────────────────────────────

/**
 * @desc  Register a new ambulance or update the driver's existing one
 * @route POST /api/ambulances
 * @access Private (Driver)
 */
exports.registerOrUpdate = async (req, res, next) => {
  try {
    const driverId = req.user._id;
    const { plateNumber, longitude, latitude, status, capacity, equipment } = req.body;

    const existing = await Ambulance.findOne({ driverId });
    const isNew    = !existing;

    if (isNew && !plateNumber) {
      throw new AppError('Plate number is required for new ambulance registration', 400);
    }

    // Validate and build location update
    let validatedLocation = null;
    if (longitude !== undefined || latitude !== undefined) {
      if (longitude === undefined || latitude === undefined) {
        throw new AppError('Both latitude and longitude are required when updating location', 400);
      }
      const lng = parseFloat(longitude);
      const lat = parseFloat(latitude);
      if (isNaN(lng) || isNaN(lat) || lng < -180 || lng > 180 || lat < -90 || lat > 90) {
        throw new AppError('Invalid coordinates', 400);
      }
      validatedLocation = { type: 'Point', coordinates: [lng, lat] };
    }

    if (status && !AMBULANCE_STATUS_VALUES.includes(status)) {
      throw new AppError('Invalid ambulance status', 400);
    }

    const updateData = {};
    if (isNew) {
      updateData.plateNumber = plateNumber.toUpperCase().trim();
      updateData.driverId    = driverId;
    }
    if (validatedLocation) {
      updateData.currentLocation = validatedLocation;
    }
    if (status) {
      updateData.status = status;
    }
    if (capacity !== undefined) {
      const cap = parseInt(capacity, 10);
      if (isNaN(cap) || cap < 1) throw new AppError('Capacity must be a positive integer', 400);
      updateData.capacity = cap;
    }
    if (equipment !== undefined) {
      if (!Array.isArray(equipment)) throw new AppError('Equipment must be an array', 400);
      updateData.equipment = equipment.map(String);
    }

    let ambulance;
    if (isNew) {
      ambulance = await Ambulance.create({
        ...updateData,
      });
      ambulance = await Ambulance.findById(ambulance._id).populate('driverId', 'name email phone');
    } else {
      if (Array.isArray(existing.currentLocation?.coordinates) && existing.currentLocation.coordinates.length !== 2) {
        existing.currentLocation = undefined;
      }

      if (validatedLocation) {
        existing.currentLocation = validatedLocation;
      }

      Object.assign(existing, updateData);
      ambulance = await existing.save();
      ambulance = await Ambulance.findById(ambulance._id).populate('driverId', 'name email phone');
    }

    res.status(isNew ? 201 : 200).json({ success: true, data: ambulance });
  } catch (err) {
    next(err);
  }
};

// ─── GET /api/ambulances ──────────────────────────────────────────────────────

/**
 * @desc  Get all ambulances (role-filtered, optional geo-sort)
 * @route GET /api/ambulances
 * @access Private (Admin, Dispatcher, Driver)
 */
exports.getAll = async (req, res, next) => {
  try {
    const { status, available, nearby, maxDistance } = req.query;
    const { role, _id: id } = req.user;

    let query = {};
    if (role === ROLES.DRIVER) query.driverId = id;
    if (status && AMBULANCE_STATUS_VALUES.includes(status)) query.status = status;
    if (available === 'true') query.status = AMBULANCE_STATUS.AVAILABLE;

    let ambulances;
    const userCoords = req.user.currentLocation?.coordinates;

    if (nearby && userCoords) {
      const [lng, lat]   = userCoords;
      const maxDist      = parseInt(maxDistance, 10) || 10_000; // 10 km default
      ambulances = await Ambulance.find({
        ...query,
        currentLocation: {
          $near: {
            $geometry: { type: 'Point', coordinates: [lng, lat] },
            $maxDistance: maxDist,
          },
        },
      }).populate('driverId', 'name phone');
    } else {
      ambulances = await Ambulance.find(query)
        .populate('driverId', 'name phone')
        .sort('-updatedAt');
    }

    // Annotate with calculated distance when user location available
    if (nearby && userCoords) {
      const [userLng, userLat] = userCoords;
      ambulances = ambulances.map((amb) => {
        const doc = amb.toObject();
        if (amb.currentLocation?.coordinates) {
          const [aLng, aLat] = amb.currentLocation.coordinates;
          doc.distanceMetres = Math.round(haversineDistance(userLat, userLng, aLat, aLng));
        }
        return doc;
      });
    }

    res.status(200).json({ success: true, count: ambulances.length, data: ambulances });
  } catch (err) {
    next(err);
  }
};

// ─── GET /api/ambulances/:id ──────────────────────────────────────────────────

/**
 * @desc  Get ambulance by ID
 * @route GET /api/ambulances/:id
 * @access Private (Admin, Dispatcher, owning Driver)
 */
exports.getById = async (req, res, next) => {
  try {
    const ambulance = await Ambulance.findById(req.params.id)
      .populate('driverId', 'name email phone');

    if (!ambulance) throw new AppError('Ambulance not found', 404);

    const { role, _id: id } = req.user;
    if (
      role !== ROLES.ADMIN &&
      role !== ROLES.DISPATCHER &&
      String(ambulance.driverId?._id) !== String(id)
    ) {
      throw new AppError('Not authorised to view this ambulance', 403);
    }

    res.status(200).json({ success: true, data: ambulance });
  } catch (err) {
    next(err);
  }
};

// ─── PATCH /api/ambulances/:id/status ────────────────────────────────────────

/**
 * @desc  Update ambulance status with transition validation
 * @route PATCH /api/ambulances/:id/status
 * @access Private (owning Driver, Admin)
 */
exports.updateStatus = async (req, res, next) => {
  try {
    const { status } = req.body;
    if (!status || !AMBULANCE_STATUS_VALUES.includes(status)) {
      throw new AppError('Valid status is required', 400);
    }

    const ambulance = await Ambulance.findById(req.params.id);
    if (!ambulance) throw new AppError('Ambulance not found', 404);

    const { role, _id: id } = req.user;
    if (role !== ROLES.ADMIN && String(ambulance.driverId) !== String(id)) {
      throw new AppError('Not authorised to update this ambulance', 403);
    }

    // FIX: use centralised AMBULANCE_TRANSITIONS constant
    const allowed = AMBULANCE_TRANSITIONS[ambulance.status] || [];
    if (!allowed.includes(status)) {
      throw new AppError(
        `Invalid status transition: ${ambulance.status} → ${status}`,
        400
      );
    }

    ambulance.status = status;
    await ambulance.save();

    // Automatically allocate any pending request when an ambulance becomes available.
    if (status === AMBULANCE_STATUS.AVAILABLE) {
      const io = req.app.get('io');
      const queueSession = await mongoose.startSession();
      queueSession.startTransaction();

      try {
        const result = await allocateQueuedRequest(queueSession);
        if (result) {
          await queueSession.commitTransaction();

          if (io) {
            const queuedEta = estimateEta(
              result.ambulance.currentLocation.coordinates,
              result.request.location.coordinates
            );

            emitDriverRoom(io, result.ambulance.driverId, 'dispatchAssigned', {
              requestId:   result.request._id,
              location:    result.request.location,
              priority:    result.request.priority,
              eta:         Math.round(queuedEta / 60),
              patientName: result.request.userName,
              patientPhone: result.request.userPhone,
            });

            io.to(`user_${result.request.userId}`).emit('ambulanceAssigned', {
              requestId:      result.request._id,
              ambulanceId:    result.ambulance._id,
              ambulancePlate: result.ambulance.plateNumber,
              eta:             Math.round(queuedEta / 60),
            });

            io.to('admins').emit('dispatchAllocated', {
              requestId:   result.request._id,
              ambulanceId: result.ambulance._id,
            });
          }
        } else {
          await queueSession.abortTransaction();
        }
      } catch (err) {
        if (queueSession.inTransaction()) await queueSession.abortTransaction();
      } finally {
        queueSession.endSession();
      }
    }

    // Broadcast to dispatchers
    const io = req.app.get('io');
    if (io) {
      io.to('dispatchers').emit('ambulanceStatusChanged', {
        ambulanceId: ambulance._id,
        status,
        timestamp:   Date.now(),
      });
    }

    res.status(200).json({ success: true, data: ambulance });
  } catch (err) {
    next(err);
  }
};

// ─── PATCH /api/ambulances/:id/location ──────────────────────────────────────

/**
 * @desc  Update ambulance GPS location (only if moved > 50 m)
 * @route PATCH /api/ambulances/:id/location
 * @access Private (owning Driver)
 */
exports.updateLocation = async (req, res, next) => {
  try {
    const { longitude, latitude } = req.body;
    if (longitude === undefined || latitude === undefined) {
      throw new AppError('longitude and latitude are required', 400);
    }

    const lng = parseFloat(longitude);
    const lat = parseFloat(latitude);
    if (isNaN(lng) || isNaN(lat) || lng < -180 || lng > 180 || lat < -90 || lat > 90) {
      throw new AppError('Invalid coordinates', 400);
    }

    const ambulance = await Ambulance.findById(req.params.id);
    if (!ambulance) throw new AppError('Ambulance not found', 404);

    if (String(ambulance.driverId) !== String(req.user._id)) {
      throw new AppError('Not authorised to update this ambulance', 403);
    }

    // Threshold: skip update if moved fewer than 50 metres (battery saving)
    if (ambulance.currentLocation?.coordinates) {
      const [oldLng, oldLat] = ambulance.currentLocation.coordinates;
      const dist = haversineDistance(lat, lng, oldLat, oldLng);
      if (dist < 50) {
        return res.status(200).json({
          success: true,
          message: 'Location unchanged (within 50 m threshold)',
          data: ambulance,
        });
      }
    }

    ambulance.currentLocation = { type: 'Point', coordinates: [lng, lat] };
    await ambulance.save();

    const io = req.app.get('io');
    if (io) {
      io.to(`ambulance_${ambulance._id}`).emit('locationUpdate', {
        ambulanceId: ambulance._id,
        coordinates: [lng, lat],
        timestamp:   Date.now(),
      });
    }

    res.status(200).json({ success: true, data: ambulance });
  } catch (err) {
    next(err);
  }
};
