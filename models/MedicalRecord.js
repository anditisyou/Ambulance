'use strict';

const mongoose = require('mongoose');

/**
 * MedicalRecord schema.
 *
 * Fixes applied:
 *  - Removed explicit `_id` override (Mongoose manages it).
 *  - Replaced manual updatedAt with Mongoose timestamps.
 *  - Added proper fields (fileUrl, filePublicId, etc.) that the controller uses.
 *  - Added `sharedWith` sub-document array used by shareMedicalRecord endpoint.
 *  - `data` (Mixed) kept for backward compatibility but clearly documented.
 */

const sharedWithSchema = new mongoose.Schema(
  {
    hospitalId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    sharedAt:    { type: Date, default: Date.now },
    expiresAt:   { type: Date, required: true },
    accessToken: { type: String, required: true, select: false }, // hidden by default
  },
  { _id: false }
);

const medicalRecordSchema = new mongoose.Schema(
  {
    userId: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'User',
      required: [true, 'User ID is required'],
      index:    true,
    },

    recordType: {
      type:     String,
      enum:     ['visit', 'prescription', 'note', 'image', 'pdf'],
      required: [true, 'Record type is required'],
    },

    /** Cloudinary secure URL */
    fileUrl: {
      type: String,
    },

    /** Cloudinary public_id (needed for deletion) */
    filePublicId: {
      type: String,
    },

    fileName: {
      type: String,
      trim: true,
    },

    fileSize: {
      type: Number,
    },

    fileType: {
      type: String, // 'image' | 'pdf'
    },

    mimeType: {
      type: String,
    },

    /** Flexible payload for visit/prescription/note record types. */
    data: mongoose.Schema.Types.Mixed,

    /** Hospitals granted temporary access by the patient. */
    sharedWith: {
      type:    [sharedWithSchema],
      default: [],
    },
  },
  {
    collection: 'medical_records',
    timestamps: true, // FIX: createdAt + updatedAt automatic
  }
);

// ─── Compound index for patient history queries ───────────────────────────────
medicalRecordSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('MedicalRecord', medicalRecordSchema);
