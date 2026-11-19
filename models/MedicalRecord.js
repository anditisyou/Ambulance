'use strict';

const mongoose = require('mongoose');
const { encrypt, decrypt } = require('../utils/encryption');

/**
 * MedicalRecord schema - COMPLETE FIXED VERSION
 */

const sharedWithSchema = new mongoose.Schema(
  {
    hospitalId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    sharedAt:    { type: Date, default: Date.now },
    expiresAt:   { type: Date, required: true },
    accessToken: { type: String, required: true, select: false },
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

    fileUrl: {
      type: String,
      required: function() {
        return this.recordType === 'image' || this.recordType === 'pdf';
      }
    },

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
      type: String,
      enum: ['image', 'pdf'],
    },

    mimeType: {
      type: String,
    },

    // Free-form clinical content is not used as a query predicate. Keep it
    // encrypted at rest and only decrypt it in an authorised application path.
    data: { type: mongoose.Schema.Types.Mixed, select: false },
    encryptedData: { type: mongoose.Schema.Types.Mixed, select: false },

    sharedWith: {
      type:    [sharedWithSchema],
      default: [],
    },
  },
  {
    collection: 'medical_records',
    timestamps: true,
  }
);

medicalRecordSchema.index({ userId: 1, createdAt: -1 });

medicalRecordSchema.pre('validate', function encryptRecordData(next) {
  if (this.isModified('data') && this.data != null) {
    this.encryptedData = encrypt(this.data);
    this.data = undefined;
  }
  next();
});

medicalRecordSchema.methods.getDecryptedData = function getDecryptedData() {
  return this.encryptedData ? decrypt(this.encryptedData, true) : null;
};

module.exports = mongoose.model('MedicalRecord', medicalRecordSchema);
