'use strict';

const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');
const { ROLES_VALUES } = require('../utils/constants');

/**
 * User schema — covers all roles: ADMIN, DISPATCHER, HOSPITAL, DRIVER, CITIZEN.
 *
 * Fixes applied:
 *  - Removed manual updatedAt field; use Mongoose `timestamps: true` instead.
 *  - Removed duplicate `role` index (already declared inline with `index: true`).
 *  - Added `isActive` field referenced in auth middleware.
 *  - Password minlength raised to 8 to match controller validation.
 *  - currentLocation made fully optional (only DRIVER / HOSPITAL need it).
 */
const userSchema = new mongoose.Schema(
  {
    name: {
      type:      String,
      required:  [true, 'Please provide a name'],
      trim:      true,
      maxlength: [50, 'Name cannot be more than 50 characters'],
    },

    email: {
      type:      String,
      required:  [true, 'Please provide an email'],
      unique:    true,
      lowercase: true,
      trim:      true,
      match:     [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Please provide a valid email address'],
      index:     true,
    },

    phone: {
      type:     String,
      required: [true, 'Please provide a phone number'],
      unique:   true,
      trim:     true,
      match:    [/^\+?[1-9]\d{1,14}$/, 'Please provide a valid phone number (E.164 format)'],
      index:    true,
    },

    role: {
      type:     String,
      enum:     ROLES_VALUES,
      default:  'CITIZEN',
      required: true,
      index:    true,
    },

    /**
     * Tracks live position for DRIVER and HOSPITAL roles.
     * GeoJSON Point — coordinates are [longitude, latitude].
     */
    currentLocation: {
      type: {
        type:        String,
        enum:        ['Point'],
        //default:     'Point',
      },
      coordinates: {
        type: [Number], // [lng, lat]
      },
    },

    password: {
      type:      String,
      required:  [true, 'Please provide a password'],
      minlength: [8, 'Password must be at least 8 characters'],
      select:    false, // never returned by default
    },

    /** Soft-delete / deactivation flag. */
    isActive: {
      type:    Boolean,
      default: true,
      index:   true,
    },
  },
  {
    collection: 'user',
    timestamps: true, // FIX: adds createdAt + updatedAt automatically; no manual bookkeeping
  }
);

// ─── Geo index for driver proximity queries ───────────────────────────────────
userSchema.index({ currentLocation: '2dsphere' }, { sparse: true });

// ─── Pre-save hook: hash password only when it has been modified ──────────────
userSchema.pre('save', async function hashPassword(next) {
  if (!this.isModified('password')) return next();

  const salt    = await bcrypt.genSalt(12); // FIX: raised from 10 → 12 (OWASP minimum)
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

// ─── Instance method: constant-time password comparison ──────────────────────
userSchema.methods.comparePassword = function comparePassword(candidate) {
  return bcrypt.compare(candidate, this.password);
};

module.exports = mongoose.model('User', userSchema);
