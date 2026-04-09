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
      trim:     true,
      uppercase: true,
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
    },

    currentLocation: {
      type: {
        type: String,
        enum: ['Point'],
      },
      coordinates: {
        type: [Number], // [longitude, latitude]
        validate: {
          validator: function (coords) {
            return coords == null || coords.length === 2;
          },
          message: 'Coordinates must be an array of two numbers',
        },
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

// ─── Performance indexes ──────────────────────────────────────────────────────
ambulanceSchema.index({ plateNumber: 1 }, { unique: true });
ambulanceSchema.index({ driverId: 1 }, { unique: true });
ambulanceSchema.index({ status: 1, currentLocation: '2dsphere' }); // Nearest available lookup
ambulanceSchema.index({ status: 1, updatedAt: -1 }); // Status monitoring

module.exports = mongoose.model('Ambulance', ambulanceSchema);
