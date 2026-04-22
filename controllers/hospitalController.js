// controllers/hospitalController.js
'use strict';

const Hospital = require('../models/Hospital');
const User = require('../models/User');
const AppError = require('../utils/AppError');
const { haversineDistance } = require('../utils/haversine');
const { ROLES } = require('../utils/constants');

/**
 * Register or update hospital profile
 */
exports.registerHospital = async (req, res, next) => {
  try {
    const { name, address, location, phone, email, beds, specialties } = req.body;
    
    if (req.user.role !== ROLES.HOSPITAL) {
      throw new AppError('Only hospital accounts can register hospital profiles', 403);
    }
    
    const hospital = await Hospital.findOneAndUpdate(
      { userId: req.user._id },
      {
        userId: req.user._id,
        name,
        address,
        location: {
          type: 'Point',
          coordinates: location.coordinates,
        },
        phone,
        email,
        beds: beds || [],
        specialties: specialties || [],
      },
      { new: true, upsert: true, runValidators: true }
    );
    
    hospital.updateCapacityStatus();
    await hospital.save();
    
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
    
    const hospital = await Hospital.findOne({ userId: req.user._id });
    if (!hospital) throw new AppError('Hospital profile not found', 404);
    
    hospital.beds = beds.map(bed => ({
      ...bed,
      lastUpdated: new Date(),
    }));
    
    hospital.updateCapacityStatus();
    await hospital.save();
    
    // Broadcast to dispatchers
    const io = req.app.get('io');
    if (io) {
      io.to('admins').emit('hospitalCapacityUpdate', {
        hospitalId: hospital._id,
        name: hospital.name,
        capacityStatus: hospital.capacityStatus,
        beds: hospital.beds,
      });
    }
    
    res.status(200).json({ success: true, data: hospital });
  } catch (err) {
    next(err);
  }
};

/**
 * Get nearby hospitals with available capacity
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
      return doc;
    });
    
    res.status(200).json({ success: true, data: withDistance });
  } catch (err) {
    next(err);
  }
};