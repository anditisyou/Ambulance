// models/Hospital.js
'use strict';

const mongoose = require('mongoose');

const hospitalBedSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['ICU', 'EMERGENCY', 'GENERAL', 'PEDIATRIC', 'BURN'],
    required: true,
  },
  total: {
    type: Number,
    required: true,
    min: 0,
  },
  available: {
    type: Number,
    required: true,
    min: 0,
    validate: {
      validator: function(v) {
        return v <= this.total;
      },
      message: 'Available beds cannot exceed total beds',
    },
  },
  lastUpdated: {
    type: Date,
    default: Date.now,
  },
});

const hospitalSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    address: {
      street: String,
      city: String,
      state: String,
      zipCode: String,
    },
    location: {
      type: {
        type: String,
        enum: ['Point'],
        default: 'Point',
      },
      coordinates: {
        type: [Number],
        required: true,
      },
    },
    phone: {
      type: String,
      required: true,
    },
    email: {
      type: String,
      required: true,
    },
    beds: [hospitalBedSchema],
    specialties: [String],
    isActive: {
      type: Boolean,
      default: true,
    },
    capacityStatus: {
      type: String,
      enum: ['AVAILABLE', 'LIMITED', 'FULL', 'CRITICAL'],
      default: 'AVAILABLE',
    },
  },
  {
    timestamps: true,
  }
);

hospitalSchema.index({ location: '2dsphere' });
hospitalSchema.index({ capacityStatus: 1 });
hospitalSchema.index({ specialties: 1 });

// Method to update capacity status based on available beds
hospitalSchema.methods.updateCapacityStatus = function() {
  const totalAvailable = this.beds.reduce((sum, bed) => sum + bed.available, 0);
  const totalBeds = this.beds.reduce((sum, bed) => sum + bed.total, 0);
  
  if (totalBeds === 0) {
    this.capacityStatus = 'AVAILABLE';
  } else {
    const ratio = totalAvailable / totalBeds;
    if (ratio === 0) this.capacityStatus = 'FULL';
    else if (ratio < 0.2) this.capacityStatus = 'CRITICAL';
    else if (ratio < 0.5) this.capacityStatus = 'LIMITED';
    else this.capacityStatus = 'AVAILABLE';
  }
  
  return this;
};

module.exports = mongoose.model('Hospital', hospitalSchema);