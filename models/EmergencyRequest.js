'use strict';

const mongoose = require('mongoose');
const {
  REQUEST_STATUS,
  REQUEST_STATUS_VALUES,
  REQUEST_PRIORITY,
  REQUEST_PRIORITY_VALUES,
  REQUEST_TYPES_VALUES,
} = require('../utils/constants');
const { publicStatusForAssignmentState } = require('../utils/requestStateMachine');
const { encrypt, decrypt } = require('../utils/encryption');

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

    allergies: {
      type: String,
      trim: true,
      default: '',
    },

    vitals: {
      heartRate: {
        type: Number,
        min: 0,
      },
      bloodPressure: {
        type: String,
        trim: true,
      },
      respiratoryRate: {
        type: Number,
        min: 0,
      },
      temperature: {
        type: Number,
        min: 25,
        max: 45,
      },
      oxygenSaturation: {
        type: Number,
        min: 0,
        max: 100,
      },
    },

    triageNotes: {
      type: String,
      maxlength: [1000, 'Triage notes cannot exceed 1000 characters'],
      default: '',
    },

    medicalHistorySummary: {
      type: String,
      maxlength: [1000, 'Medical history summary cannot exceed 1000 characters'],
      default: '',
    },

    // Clinical information is not part of dispatch matching or indexing. It is
    // stored as one authenticated encrypted payload rather than plaintext.
    encryptedClinicalData: {
      type: mongoose.Schema.Types.Mixed,
      select: false,
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
      set: (value) => {
        const normalized = String(value || '').toUpperCase();
        return REQUEST_PRIORITY_VALUES.includes(normalized) ? normalized : REQUEST_PRIORITY.MEDIUM;
      },
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

    assignedBedType: {
      type: String,
      enum: ['ICU', 'EMERGENCY', 'GENERAL', 'PEDIATRIC', 'BURN'],
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

    // ─── New state machine fields ─────────────────────────────────────────
    // Tracks assignment state: PENDING → ASSIGNED → ACCEPTED → EN_ROUTE → COMPLETED
    assignmentState: {
      type:    String,
      enum:    [...REQUEST_STATUS_VALUES, 'REJECTED'],
      default: 'PENDING',
      index:   true,
    },

    // Driver acceptance deadline (SLA timeout, typically 5min from assignment)
    assignmentAcceptanceDeadline: Date,

    // Timestamp when driver accepted the assignment
    acceptedTime: Date,

    // Timestamp when driver marked request as en-route
    enRouteTime: Date,

    // Driver location during en-route (GeoJSON Point for real-time tracking)
    driverLocation: {
      type: {
        type:    String,
        enum:    ['Point'],
        default: 'Point',
      },
      coordinates: {
        type: [Number], // [longitude, latitude]
        default: [0, 0], // ✅ FIX: Default coordinates to prevent invalid GeoJSON
      },
    },

    // Driver rejection reason for audit/compliance
    rejectionReason: {
      type: String,
      trim: true,
    },

    // Rejection timestamp for audit
    rejectionTime: Date,

    stateHistory: [{
      from: String,
      to: String,
      timestamp: {
        type: Date,
        default: Date.now,
      },
      context: mongoose.Schema.Types.Mixed,
      userId: mongoose.Schema.Types.ObjectId,
    }],

    completionTime: Date,

    // Logical retention marker only. It never asserts that an external archive
    // object was created or that the record left MongoDB.
    logicalArchived: { type: Boolean, default: false, index: true },
    logicalArchivedAt: Date,
  },
  {
    collection: 'emergency_requests',
    timestamps: true, // FIX: replaces manual updatedAt
  }
);

// ─── Geospatial index ─────────────────────────────────────────────────────────
emergencyRequestSchema.index({ location: '2dsphere' });
emergencyRequestSchema.index({ driverLocation: '2dsphere' });

// ─── State machine tracking ───────────────────────────────────────────────────
emergencyRequestSchema.index({ assignmentState: 1, assignedAmbulanceId: 1 });
emergencyRequestSchema.index({ assignmentAcceptanceDeadline: 1, assignmentState: 1 }, { sparse: true });

// ─── Performance indexes ──────────────────────────────────────────────────────
emergencyRequestSchema.index({ status: 1, priority: -1, requestTime: 1 }); // Dispatcher queue
emergencyRequestSchema.index({ userId: 1, requestTime: -1 }); // Citizen history
emergencyRequestSchema.index({ assignedAmbulanceId: 1, status: 1 }, { sparse: true }); // Driver lookups
emergencyRequestSchema.index({ assignedHospital: 1, status: 1 }, { sparse: true }); // Hospital lookups
emergencyRequestSchema.index({ assignmentState: 1, assignmentAcceptanceDeadline: 1 }, { sparse: true }); // SLA monitoring
emergencyRequestSchema.index({ createdAt: -1 }); // Recent requests
emergencyRequestSchema.index({ updatedAt: -1 }); // Recent updates

emergencyRequestSchema.pre('validate', function keepAssignmentStateConsistent(next) {
  const statusBackedStates = new Set(REQUEST_STATUS_VALUES);

  if (this.assignmentState === 'REJECTED') {
    this.status = REQUEST_STATUS.PENDING;
    return next();
  }

  if (this.isModified('status') && !this.isModified('assignmentState') && statusBackedStates.has(this.status)) {
    this.assignmentState = this.status;
  }

  const mirroredStatus = publicStatusForAssignmentState(this.assignmentState);
  if (mirroredStatus) {
    this.status = mirroredStatus;
  }

  next();
});

emergencyRequestSchema.pre('save', function encryptClinicalData(next) {
  const clinicalData = {
    allergies: this.allergies,
    vitals: this.vitals && this.vitals.toObject ? this.vitals.toObject() : this.vitals,
    triageNotes: this.triageNotes,
    medicalHistorySummary: this.medicalHistorySummary,
  };
  const hasClinicalData = Object.values(clinicalData).some((value) => (
    value && (typeof value !== 'object' || Object.values(value).some((entry) => entry != null && entry !== ''))
  ));

  if (hasClinicalData && (
    this.isNew || this.isModified('allergies') || this.isModified('vitals') ||
    this.isModified('triageNotes') || this.isModified('medicalHistorySummary')
  )) {
    this.encryptedClinicalData = encrypt(clinicalData);
    this.allergies = undefined;
    this.vitals = undefined;
    this.triageNotes = undefined;
    this.medicalHistorySummary = undefined;
  }
  next();
});

emergencyRequestSchema.methods.getDecryptedClinicalData = function getDecryptedClinicalData() {
  return this.encryptedClinicalData ? decrypt(this.encryptedClinicalData, true) : null;
};

emergencyRequestSchema.statics.decryptClinicalData = function decryptClinicalData(request) {
  return request?.encryptedClinicalData ? decrypt(request.encryptedClinicalData, true) : null;
};

module.exports = mongoose.model('EmergencyRequest', emergencyRequestSchema);
