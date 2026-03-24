'use strict';

const mongoose      = require('mongoose'); // FIX: was missing — caused crash in deleteMedicalRecord
const crypto        = require('crypto');
const path          = require('path');
const fs            = require('fs').promises;
const cloudinary    = require('cloudinary').v2;
const MedicalRecord = require('../models/MedicalRecord');
const User          = require('../models/User');
const AppError      = require('../utils/AppError');
const { ROLES }     = require('../utils/constants');

// ─── Cloudinary configuration ─────────────────────────────────────────────────

const REQUIRED_CLOUDINARY_VARS = [
  'CLOUDINARY_CLOUD_NAME',
  'CLOUDINARY_API_KEY',
  'CLOUDINARY_API_SECRET',
];

const missingVars = REQUIRED_CLOUDINARY_VARS.filter((v) => !process.env[v]);
if (missingVars.length > 0) {
  console.error(`[Medical] Missing Cloudinary env vars: ${missingVars.join(', ')}`);
}

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ─── File upload constraints ──────────────────────────────────────────────────

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'application/pdf',
]);

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

// ─── POST /api/medical/upload ─────────────────────────────────────────────────

/**
 * @desc  Upload a medical document or image to Cloudinary
 * @route POST /api/medical/upload
 * @access Private (any authenticated user)
 */
exports.uploadMedicalRecord = async (req, res, next) => {
  try {
    if (!req.file) throw new AppError('Please upload a file', 400);

    // ── Size check ──
    if (req.file.size > MAX_FILE_SIZE) {
      await fs.unlink(req.file.path).catch(() => {});
      throw new AppError(`File exceeds the ${MAX_FILE_SIZE / (1024 * 1024)} MB limit`, 400);
    }

    // ── MIME type check ──
    if (!ALLOWED_MIME_TYPES.has(req.file.mimetype)) {
      await fs.unlink(req.file.path).catch(() => {});
      throw new AppError('Only JPEG, PNG, GIF images and PDF files are allowed', 400);
    }

    const fileType = req.file.mimetype.startsWith('image/') ? 'image' : 'pdf';

    // ── Upload to Cloudinary ──
    let uploadResult;
    try {
      uploadResult = await cloudinary.uploader.upload(req.file.path, {
        folder:        `medical-records/${req.user._id}`,
        resource_type: 'auto',
        public_id:     `${Date.now()}-${path.parse(req.file.originalname).name}`,
        tags:          [`user-${req.user._id}`, fileType],
      });
    } catch (cloudErr) {
      console.error('[Medical] Cloudinary upload error:', cloudErr.message);
      await fs.unlink(req.file.path).catch(() => {});
      throw new AppError('File storage service unavailable — please try again', 503);
    }

    // ── Clean up temp file ──
    await fs.unlink(req.file.path).catch((err) =>
      console.warn('[Medical] Failed to delete temp file:', err.message)
    );

    // FIX: schema now has fileUrl/filePublicId/etc. fields (aligned model + controller)
    const record = await MedicalRecord.create({
      userId:       req.user._id,
      recordType:   fileType,
      fileUrl:      uploadResult.secure_url,
      filePublicId: uploadResult.public_id,
      fileName:     req.file.originalname,
      fileSize:     req.file.size,
      fileType,
      mimeType:     req.file.mimetype,
    });

    res.status(201).json({ success: true, data: record });
  } catch (err) {
    // Safety net: delete temp file if something above threw before unlink
    if (req.file?.path) {
      await fs.unlink(req.file.path).catch(() => {});
    }
    next(err);
  }
};

// ─── GET /api/medical/:userId ─────────────────────────────────────────────────

/**
 * @desc  Get medical records for a user (own records or hospital viewing patient)
 * @route GET /api/medical/:userId
 * @access Private (Owner or Hospital)
 */
exports.getMedicalRecords = async (req, res, next) => {
  try {
    const { userId }            = req.params;
    const { type, limit = 50, page = 1 } = req.query;

    const pageNum  = Math.max(1, parseInt(page, 10)  || 1);
    const limitNum = Math.min(100, parseInt(limit, 10) || 50);
    const skip     = (pageNum - 1) * limitNum;

    // ── Authorisation ──
    if (req.user.role !== ROLES.HOSPITAL && String(req.user._id) !== userId) {
      throw new AppError('Not authorised to view these records', 403);
    }

    const user = await User.findById(userId).lean();
    if (!user) throw new AppError('User not found', 404);

    const query = { userId };
    if (type) {
      if (!['image', 'pdf', 'visit', 'prescription', 'note'].includes(type)) {
        throw new AppError('Invalid file type filter', 400);
      }
      query.recordType = type;
    }

    const [records, total] = await Promise.all([
      MedicalRecord.find(query)
        .select('-sharedWith.accessToken') // never expose access tokens in list
        .sort('-createdAt')
        .skip(skip)
        .limit(limitNum)
        .lean(),
      MedicalRecord.countDocuments(query),
    ]);

    res.status(200).json({
      success: true,
      count:   records.length,
      total,
      page:    pageNum,
      pages:   Math.ceil(total / limitNum),
      data:    records,
      patient: { id: user._id, name: user.name },
    });
  } catch (err) {
    next(err);
  }
};

// ─── GET /api/medical/record/:id ──────────────────────────────────────────────

/**
 * @desc  Get single medical record by ID
 * @route GET /api/medical/record/:id
 * @access Private (Owner or Hospital)
 */
exports.getMedicalRecord = async (req, res, next) => {
  try {
    const record = await MedicalRecord.findById(req.params.id)
      .select('-sharedWith.accessToken')
      .lean();

    if (!record) throw new AppError('Medical record not found', 404);

    if (req.user.role !== ROLES.HOSPITAL && String(req.user._id) !== String(record.userId)) {
      throw new AppError('Not authorised to view this record', 403);
    }

    res.status(200).json({ success: true, data: record });
  } catch (err) {
    next(err);
  }
};

// ─── DELETE /api/medical/record/:id ──────────────────────────────────────────

/**
 * @desc  Delete a medical record (Cloudinary + DB)
 * @route DELETE /api/medical/record/:id
 * @access Private (Owner only)
 */
exports.deleteMedicalRecord = async (req, res, next) => {
  // FIX: mongoose was never imported — session() call crashed at runtime
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const record = await MedicalRecord.findById(req.params.id).session(session);
    if (!record) throw new AppError('Medical record not found', 404);

    if (String(record.userId) !== String(req.user._id)) {
      throw new AppError('Not authorised to delete this record', 403);
    }

    // Delete from Cloudinary first (non-fatal if it fails — file will be orphaned
    // but DB will be clean; a background job should reconcile periodically)
    if (record.filePublicId) {
      try {
        await cloudinary.uploader.destroy(record.filePublicId, { invalidate: true });
      } catch (cloudErr) {
        console.warn('[Medical] Cloudinary delete warning:', cloudErr.message);
      }
    }

    await record.deleteOne({ session });
    await session.commitTransaction();

    res.status(200).json({ success: true, message: 'Medical record deleted successfully' });
  } catch (err) {
    await session.abortTransaction();
    next(err);
  } finally {
    session.endSession();
  }
};

// ─── POST /api/medical/share/:recordId ────────────────────────────────────────

/**
 * @desc  Share a record with a hospital for a limited time
 * @route POST /api/medical/share/:recordId
 * @access Private (Owner only)
 */
exports.shareMedicalRecord = async (req, res, next) => {
  try {
    const { recordId }             = req.params;
    const { hospitalId, expiryHours = 24 } = req.body;

    if (!hospitalId) throw new AppError('hospitalId is required', 400);

    const hours = Math.min(168, Math.max(1, parseInt(expiryHours, 10) || 24)); // 1h–7d

    const record = await MedicalRecord.findById(recordId);
    if (!record) throw new AppError('Medical record not found', 404);

    if (String(record.userId) !== String(req.user._id)) {
      throw new AppError('Not authorised to share this record', 403);
    }

    const hospital = await User.findOne({ _id: hospitalId, role: ROLES.HOSPITAL }).lean();
    if (!hospital) throw new AppError('Hospital not found', 404);

    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + hours);

    // Remove any existing share for this hospital before adding a new one
    record.sharedWith = (record.sharedWith || []).filter(
      (s) => String(s.hospitalId) !== String(hospitalId)
    );
    record.sharedWith.push({
      hospitalId,
      sharedAt:    new Date(),
      expiresAt,
      accessToken: crypto.randomBytes(32).toString('hex'),
    });

    await record.save();

    res.status(200).json({
      success: true,
      message: 'Record shared successfully',
      data: {
        hospitalName: hospital.name,
        expiresAt,
        durationHours: hours,
      },
    });
  } catch (err) {
    next(err);
  }
};
