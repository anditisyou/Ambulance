'use strict';

const mongoose = require('mongoose');
const { AMBULANCE_STATUS_VALUES } = require('../utils/constants');

/**
 * Ambulance schema.
 *
 * Fixes applied:
 *  - coordinates.required removed — allows creating record before first GPS fix.
 *  - lastUpdated replaced by Mongoose timestamps (consistent with other models).
 *  - plateNumber uniqueness enforced at DB level.
 *  - capacity default raised to 1 (0 is never valid for an active vehicle).
 */
const ambulanceSchema = new mongoose.Schema(
  {
    plateNumber: {
      type:     String,
      required: [true, 'Plate number is required'],
      unique:   true,
      trim:     true,
      uppercase: true,
      index:    true,
    },

    status: {
      type:    String,
      enum:    AMBULANCE_STATUS_VALUES,
      default: 'AVAILABLE',
      index:   true,
    },

    driverId: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'User',
      required: [true, 'Driver is required'],
      unique:   true, // one ambulance per driver
      index:    true,
    },

    currentLocation: {
      type: {
        type:    String,
        enum:    ['Point'],
        default: 'Point',
      },
      coordinates: {
        type: [Number], // [longitude, latitude]
      },
    },

    capacity: {
      type:    Number,
      default: 1,
      min:     [1, 'Capacity must be at least 1'],
    },

    equipment: {
      type:    [String],
      default: [],
    },
  },
  {
    collection: 'ambulances',
    timestamps: true, // FIX: use Mongoose timestamps instead of manual lastUpdated
  }
);

// ─── 2dsphere index for $near / $geoWithin queries ────────────────────────────
ambulanceSchema.index({ currentLocation: '2dsphere' });

// ─── Compound index: dispatcher's "find nearest available" query ──────────────
ambulanceSchema.index({ status: 1, currentLocation: '2dsphere' });

module.exports = mongoose.model('Ambulance', ambulanceSchema);
