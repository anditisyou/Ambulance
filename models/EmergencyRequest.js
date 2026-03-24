'use strict';

const mongoose = require('mongoose');
const {
  REQUEST_STATUS_VALUES,
  REQUEST_PRIORITY_VALUES,
  REQUEST_TYPES_VALUES,
} = require('../utils/constants');

/**
 * EmergencyRequest schema.
 *
 * Fixes applied:
 *  - Removed manual updatedAt; using Mongoose timestamps.
 *  - Removed duplicate status/priority index declarations.
 *  - Added sparse option to assignedAmbulanceId / assignedHospital indexes
 *    so they don't index null entries.
 *  - Removed one of two conflicting compound indexes on (status, priority, requestTime).
 */
const emergencyRequestSchema = new mongoose.Schema(
  {
    userId: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'User',
      required: [true, 'User ID is required'],
      index:    true,
    },

    userName: {
      type:     String,
      required: [true, 'User name is required'],
      trim:     true,
    },

    userPhone: {
      type:     String,
      required: [true, 'User phone is required'],
      trim:     true,
    },

    type: {
      type:    String,
      enum:    REQUEST_TYPES_VALUES,
      default: 'MEDICAL',
    },

    description: {
      type:      String,
      maxlength: [500, 'Description cannot exceed 500 characters'],
      default:   '',
    },

    /** GeoJSON Point — [longitude, latitude] */
    location: {
      type: {
        type:    String,
        enum:    ['Point'],
        default: 'Point',
      },
      coordinates: {
        type:     [Number],
        required: [true, 'Location coordinates are required'],
      },
    },

    priority: {
      type:    String,
      enum:    REQUEST_PRIORITY_VALUES,
      default: 'MEDIUM',
      index:   true,
    },

    status: {
      type:    String,
      enum:    REQUEST_STATUS_VALUES,
      default: 'PENDING',
      index:   true,
    },

    assignedHospital: {
      type:   mongoose.Schema.Types.ObjectId,
      ref:    'User',
      sparse: true,
    },

    assignedAmbulanceId: {
      type:   mongoose.Schema.Types.ObjectId,
      ref:    'Ambulance',
      sparse: true,
    },

    requestTime: {
      type:    Date,
      default: Date.now,
      index:   true,
    },

    allocationTime: Date,
    completionTime: Date,
  },
  {
    collection: 'emergency_requests',
    timestamps: true, // FIX: replaces manual updatedAt
  }
);

// ─── Geospatial index ─────────────────────────────────────────────────────────
emergencyRequestSchema.index({ location: '2dsphere' });

// ─── Dispatcher queue: fetch pending/high-priority first ─────────────────────
emergencyRequestSchema.index({ status: 1, priority: -1, requestTime: 1 });

// ─── Citizen history ──────────────────────────────────────────────────────────
emergencyRequestSchema.index({ userId: 1, requestTime: -1 });

// ─── Ambulance assignment lookups ────────────────────────────────────────────
emergencyRequestSchema.index({ assignedAmbulanceId: 1, status: 1 }, { sparse: true });

module.exports = mongoose.model('EmergencyRequest', emergencyRequestSchema);
