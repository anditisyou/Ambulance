// controllers/hospitalController.js
'use strict';

const Hospital = require('../models/Hospital');
const User = require('../models/User');
const Ambulance = require('../models/Ambulance');
const EmergencyRequest = require('../models/EmergencyRequest');
const AppError = require('../utils/AppError');
const { haversineDistance } = require('../utils/haversine');
const { ROLES, REQUEST_STATUS } = require('../utils/constants');

const BED_TYPES = ['ICU', 'EMERGENCY', 'GENERAL', 'PEDIATRIC', 'BURN'];

const normalizeBed = (bed) => {
  const type = String(bed?.type || '').trim().toUpperCase();
  const total = Number(bed?.total);
  const available = Number(bed?.available);

  if (!BED_TYPES.includes(type)) {
    throw new AppError(`Invalid bed type. Allowed types: ${BED_TYPES.join(', ')}`, 400);
  }
  if (!Number.isInteger(total) || total < 0) {
    throw new AppError(`Total beds for ${type} must be a non-negative integer`, 400);
  }
  if (!Number.isInteger(available) || available < 0) {
    throw new AppError(`Available beds for ${type} must be a non-negative integer`, 400);
  }
  if (available > total) {
    throw new AppError(`Available ${type} beds cannot exceed total beds`, 400);
  }

  return { type, total, available, lastUpdated: new Date() };
};

const totalAvailableBeds = (hospital) =>
  (hospital.beds || []).reduce((sum, bed) => sum + Number(bed.available || 0), 0);

const emitCapacityUpdate = (req, hospital) => {
  const io = req.app.get('io');
  if (!io) return;

  const payload = {
    hospitalId: hospital._id,
    userId: hospital.userId,
    name: hospital.name,
    capacityStatus: hospital.capacityStatus,
    beds: hospital.beds,
    availableBeds: totalAvailableBeds(hospital),
  };

  io.to('admins').emit('hospitalCapacityUpdate', payload);
  io.to('dispatchers').emit('hospitalCapacityUpdate', payload);
  io.to(`hospital_${hospital.userId}`).emit('hospitalCapacityUpdate', payload);
};

/**
 * Register or update hospital profile
 */
exports.registerHospital = async (req, res, next) => {
  try {
    const { name, address, location, phone, email, beds, specialties } = req.body;
    
    if (req.user.role !== ROLES.HOSPITAL) {
      throw new AppError('Only hospital accounts can register hospital profiles', 403);
    }
    
    const coordinates = location?.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length !== 2) {
      throw new AppError('Hospital location coordinates are required as [longitude, latitude]', 400);
    }

    const [longitude, latitude] = coordinates.map(Number);
    if (
      Number.isNaN(longitude) ||
      Number.isNaN(latitude) ||
      longitude < -180 ||
      longitude > 180 ||
      latitude < -90 ||
      latitude > 90
    ) {
      throw new AppError('Invalid hospital location coordinates', 400);
    }

    const normalizedBeds = Array.isArray(beds) ? beds.map(normalizeBed) : [];

    const hospital = await Hospital.findOneAndUpdate(
      { userId: req.user._id },
      {
        userId: req.user._id,
        name: name || req.user.name,
        address: address || {},
        location: {
          type: 'Point',
          coordinates: [longitude, latitude],
        },
        phone: phone || req.user.phone,
        email: email || req.user.email,
        beds: normalizedBeds,
        specialties: specialties || [],
      },
      { new: true, upsert: true, runValidators: true }
    );
    
    hospital.updateCapacityStatus();
    await hospital.save();

    emitCapacityUpdate(req, hospital);
    
    res.status(200).json({ success: true, data: hospital });
  } catch (err) {
    next(err);
  }
};

/**
 * Get current hospital profile and bed status
 */
exports.getHospitalProfile = async (req, res, next) => {
  try {
    if (req.user.role !== ROLES.HOSPITAL) {
      throw new AppError('Only hospital accounts can access this endpoint', 403);
    }

    const hospital = await Hospital.findOne({ userId: req.user._id });
    if (!hospital) throw new AppError('Hospital profile not found', 404);

    hospital.updateCapacityStatus();
    await hospital.save();

    res.status(200).json({ success: true, data: hospital });
  } catch (err) {
    next(err);
  }
};

/**
 * Update bed availability
 */
exports.updateBeds = async (req, res, next) => {
  try {
    const { beds } = req.body;
    if (!Array.isArray(beds) || beds.length === 0) {
      throw new AppError('beds must be a non-empty array', 400);
    }
    
    const hospital = await Hospital.findOne({ userId: req.user._id });
    if (!hospital) throw new AppError('Hospital profile not found', 404);
    
    hospital.beds = beds.map(normalizeBed);
    
    hospital.updateCapacityStatus();
    await hospital.save();
    
    emitCapacityUpdate(req, hospital);
    
    res.status(200).json({ success: true, data: hospital });
  } catch (err) {
    next(err);
  }
};

/**
 * Add a new bed category to the current hospital.
 */
exports.addBeds = async (req, res, next) => {
  try {
    const bed = normalizeBed(req.body);
    const hospital = await Hospital.findOne({ userId: req.user._id });
    if (!hospital) throw new AppError('Hospital profile not found', 404);

    const existing = hospital.beds.find((item) => item.type === bed.type);
    if (existing) {
      throw new AppError(`${bed.type} beds already exist. Use update instead.`, 409);
    }

    hospital.beds.push(bed);
    hospital.updateCapacityStatus();
    await hospital.save();

    emitCapacityUpdate(req, hospital);
    res.status(201).json({ success: true, data: hospital });
  } catch (err) {
    next(err);
  }
};

/**
 * Update one bed category without replacing the whole bed list.
 */
exports.updateBedType = async (req, res, next) => {
  try {
    const type = String(req.params.type || '').trim().toUpperCase();
    if (!BED_TYPES.includes(type)) {
      throw new AppError(`Invalid bed type. Allowed types: ${BED_TYPES.join(', ')}`, 400);
    }

    const hospital = await Hospital.findOne({ userId: req.user._id });
    if (!hospital) throw new AppError('Hospital profile not found', 404);

    const bed = hospital.beds.find((item) => item.type === type);
    if (!bed) throw new AppError(`${type} beds not found`, 404);

    const total = req.body.total == null ? bed.total : Number(req.body.total);
    const available = req.body.available == null ? bed.available : Number(req.body.available);
    const normalized = normalizeBed({ type, total, available });

    bed.total = normalized.total;
    bed.available = normalized.available;
    bed.lastUpdated = normalized.lastUpdated;

    hospital.updateCapacityStatus();
    await hospital.save();

    emitCapacityUpdate(req, hospital);
    res.status(200).json({ success: true, data: hospital });
  } catch (err) {
    next(err);
  }
};

/**
 * Delete one bed category from the current hospital profile.
 */
exports.deleteBedType = async (req, res, next) => {
  try {
    const type = String(req.params.type || '').trim().toUpperCase();
    if (!BED_TYPES.includes(type)) {
      throw new AppError(`Invalid bed type. Allowed types: ${BED_TYPES.join(', ')}`, 400);
    }

    const hospital = await Hospital.findOne({ userId: req.user._id });
    if (!hospital) throw new AppError('Hospital profile not found', 404);

    const originalCount = hospital.beds.length;
    hospital.beds = hospital.beds.filter((item) => item.type !== type);
    if (hospital.beds.length === originalCount) {
      throw new AppError(`${type} beds not found`, 404);
    }

    hospital.updateCapacityStatus();
    await hospital.save();

    emitCapacityUpdate(req, hospital);
    res.status(200).json({ success: true, data: hospital });
  } catch (err) {
    next(err);
  }
};

/**
 * Export hospital data
 */
exports.exportData = async (req, res, next) => {
  try {
    const hospital = await Hospital.findOne({ userId: req.user._id });
    if (!hospital) throw new AppError('Hospital profile not found', 404);

    const data = {
      hospital: {
        name: hospital.name,
        address: hospital.address,
        phone: hospital.phone,
        email: hospital.email,
        specialties: hospital.specialties,
        beds: hospital.beds,
        capacityStatus: hospital.capacityStatus,
        isAvailable: hospital.isActive,
        createdAt: hospital.createdAt,
        updatedAt: hospital.updatedAt,
      }
    };

    const format = req.query.format || 'json';
    if (format === 'csv') {
      // Simple CSV export
      let csv = 'Category,Value\n';
      csv += `Name,${hospital.name}\n`;
      csv += `Phone,${hospital.phone}\n`;
      csv += `Email,${hospital.email}\n`;
      csv += `Capacity Status,${hospital.capacityStatus}\n`;
      csv += `Available,${hospital.isActive}\n`;
      hospital.beds.forEach(bed => {
        csv += `Bed ${bed.type} Total,${bed.total}\n`;
        csv += `Bed ${bed.type} Available,${bed.available}\n`;
      });

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="hospital-data.csv"');
      res.send(csv);
    } else {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', 'attachment; filename="hospital-data.json"');
      res.send(JSON.stringify(data, null, 2));
    }
  } catch (err) {
    next(err);
  }
};

/**
 * @desc  Toggle hospital availability status
 * @route PATCH /api/hospital/availability
 * @access Private (Hospital)
 */
exports.toggleAvailability = async (req, res, next) => {
  try {
    const hospital = await Hospital.findOne({ userId: req.user._id });
    if (!hospital) throw new AppError('Hospital profile not found', 404);

    hospital.isActive = !hospital.isActive;
    await hospital.save();

    res.status(200).json({ 
      success: true, 
      data: { isAvailable: hospital.isActive },
      message: `Hospital is now ${hospital.isActive ? 'available' : 'unavailable'}`
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Get hospital statistics
 */
exports.getStatistics = async (req, res, next) => {
  try {
    const hospital = await Hospital.findOne({ userId: req.user._id });
    if (!hospital) throw new AppError('Hospital profile not found', 404);

    // Get request statistics
    const totalRequests = await EmergencyRequest.countDocuments({ assignedHospital: req.user._id });
    const completedRequests = await EmergencyRequest.countDocuments({ 
      assignedHospital: req.user._id, 
      status: REQUEST_STATUS.COMPLETED 
    });
    const cancelledRequests = await EmergencyRequest.countDocuments({ 
      assignedHospital: req.user._id, 
      status: REQUEST_STATUS.CANCELLED 
    });

    const stats = {
      hospital: {
        name: hospital.name,
        capacityStatus: hospital.capacityStatus,
        isAvailable: hospital.isActive,
        totalBeds: hospital.beds.reduce((sum, bed) => sum + bed.total, 0),
        availableBeds: hospital.beds.reduce((sum, bed) => sum + bed.available, 0),
      },
      requests: {
        total: totalRequests,
        completed: completedRequests,
        cancelled: cancelledRequests,
        active: totalRequests - completedRequests - cancelledRequests,
      },
      beds: hospital.beds,
    };

    res.status(200).json({ success: true, data: stats });
  } catch (err) {
    next(err);
  }
};

// ─── GET /api/hospital/nearby ─────────────────────────────────────────────────

/**
 * @desc  Get nearby hospitals
 * @route GET /api/hospital/nearby
 * @access Private (Hospital)
 */
exports.getNearbyHospitals = async (req, res, next) => {
  try {
    const { longitude, latitude, maxDistance = 20000, specialty } = req.query;
    const locLng = parseFloat(longitude);
    const locLat = parseFloat(latitude);

    if (Number.isNaN(locLng) || Number.isNaN(locLat)) {
      throw new AppError('Invalid hospital location coordinates', 400);
    }

    const filter = {
      location: {
        $near: {
          $geometry: {
            type: 'Point',
            coordinates: [locLng, locLat],
          },
          $maxDistance: parseInt(maxDistance, 10),
        },
      },
      isActive: true,
      capacityStatus: { $in: ['AVAILABLE', 'LIMITED'] },
      beds: { $elemMatch: { available: { $gt: 0 } } },
    };

    if (specialty) {
      filter.specialties = { $in: [specialty] };
    }

    const hospitals = await Hospital.find(filter).limit(20);
    
    // Add distance calculation
    const withDistance = hospitals.map(h => {
      const doc = h.toObject();
      const [hLng, hLat] = h.location.coordinates;
      const distance = haversineDistance(locLat, locLng, hLat, hLng);
      doc.distanceMetres = Math.round(distance);
      doc.availableBeds = totalAvailableBeds(h);
      return doc;
    });
    
    res.status(200).json({ success: true, data: withDistance });
  } catch (err) {
    next(err);
  }
};

/**
 * Get the closest hospital with available beds for the authenticated driver.
 */
exports.getNearestAvailableForDriver = async (req, res, next) => {
  try {
    if (req.user.role !== ROLES.DRIVER) {
      throw new AppError('Only drivers can access nearest hospital lookup', 403);
    }

    const ambulance = await Ambulance.findOne({ driverId: req.user._id }).lean();
    if (!ambulance) throw new AppError('Ambulance not found for this driver', 404);

    const coords = ambulance.currentLocation?.coordinates;
    if (!Array.isArray(coords) || coords.length !== 2) {
      throw new AppError('Ambulance location is unavailable. Update driver location first.', 400);
    }

    const [locLng, locLat] = coords;
    const maxDistance = parseInt(req.query.maxDistance, 10) || 50_000;
    const specialty = req.query.specialty;

    const filter = {
      location: {
        $near: {
          $geometry: {
            type: 'Point',
            coordinates: [locLng, locLat],
          },
          $maxDistance: maxDistance,
        },
      },
      isActive: true,
      capacityStatus: { $in: ['AVAILABLE', 'LIMITED'] },
      beds: { $elemMatch: { available: { $gt: 0 } } },
    };

    if (specialty) {
      filter.specialties = { $in: [specialty] };
    }

    const hospital = await Hospital.findOne(filter).populate('userId', 'name phone email').lean();
    if (!hospital) {
      return res.status(200).json({
        success: true,
        data: null,
        message: 'No nearby hospital with available beds found',
      });
    }

    const [hLng, hLat] = hospital.location.coordinates;
    const distanceMetres = Math.round(haversineDistance(locLat, locLng, hLat, hLng));

    res.status(200).json({
      success: true,
      data: {
        ...hospital,
        distanceMetres,
        availableBeds: totalAvailableBeds(hospital),
        routeUrl: `https://www.google.com/maps/dir/?api=1&origin=${locLat},${locLng}&destination=${hLat},${hLng}&travelmode=driving`,
      },
    });
  } catch (err) {
    next(err);
  }
};
