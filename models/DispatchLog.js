'use strict';

const mongoose = require('mongoose');
const { DISPATCH_STATUS_VALUES } = require('../utils/constants');

/**
 * DispatchLog schema — audit trail for every dispatch event.
 *
 * Fixes applied:
 *  - Removed explicit `_id` field override (Mongoose handles it automatically).
 *  - Added `logs` array sub-document so controllers can $push structured entries.
 *  - Use Mongoose timestamps for createdAt / updatedAt.
 *  - dispatcher made optional via `required: false` (kept) but now documented.
 */

const logEntrySchema = new mongoose.Schema(
  {
    timestamp: { type: Date, default: Date.now },
    message:   { type: String, required: true, maxlength: 1000 },
    driverId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    location:  { type: [Number] }, // [lng, lat] snapshot at log time
  },
  { _id: false } // embedded subdocs don't need their own IDs
);

const dispatchLogSchema = new mongoose.Schema(
  {
    requestId: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'EmergencyRequest',
      required: [true, 'requestId is required'],
      index:    true,
    },

    ambulanceId: {
      type:  mongoose.Schema.Types.ObjectId,
      ref:   'Ambulance',
      index: true,
    },

    /** The dispatcher user who initiated this log (null = auto-dispatched). */
    dispatcher: {
      type:  mongoose.Schema.Types.ObjectId,
      ref:   'User',
      index: true,
    },

    status: {
      type:    String,
      enum:    DISPATCH_STATUS_VALUES,
      default: 'PENDING',
      index:   true,
    },

    rejectedAmbulances: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Ambulance',
    }],

    /** Structured event log appended via $push. */
    logs: {
      type:    [logEntrySchema],
      default: [],
    },

    // Timeline milestones
    dispatchedAt: Date,
    responseTime: Date, // when driver accepted/rejected
    acceptedAt:   Date,
    arrivedAt:    Date,
    completedAt:  Date,
    queuedAt:     Date,

    notes: {
      type:      String,
      maxlength: 2000,
    },
  },
  {
    collection: 'dispatch_logs',
    timestamps: true,
  }
);

module.exports = mongoose.model('DispatchLog', dispatchLogSchema);
