'use strict';

const mongoose = require('mongoose');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs').promises;
const { Buffer } = require('buffer');
const cloudinary = require('cloudinary').v2;
const MedicalRecord = require('../models/MedicalRecord');
const User = require('../models/User');
const EmergencyRequest = require('../models/EmergencyRequest');
const AppError = require('../utils/AppError');
const { ROLES } = require('../utils/constants');

// Cloudinary configuration
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
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// File upload constraints
const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'application/pdf',
]);

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MEDICAL_FILE_URL_TTL_SECONDS = parseInt(process.env.MEDICAL_FILE_URL_TTL_SECONDS, 10) || 300;

const hasCloudinarySigningConfig = () => REQUIRED_CLOUDINARY_VARS.every((v) => Boolean(process.env[v]));

const getResourceType = (record) => record.fileType === 'pdf' || record.recordType === 'pdf' ? 'raw' : 'image';

const getSignedCloudinaryUrl = (record) => {
  if (!record.filePublicId || !hasCloudinarySigningConfig()) return null;

  return cloudinary.url(record.filePublicId, {
    resource_type: getResourceType(record),
    type: 'authenticated',
    sign_url: true,
    secure: true,
    expires_at: Math.floor(Date.now() / 1000) + MEDICAL_FILE_URL_TTL_SECONDS,
  });
};

const streamStoredMedicalFile = async (record, res) => {
  if (typeof fetch !== 'function') {
    throw new AppError('File proxy unavailable in this runtime', 503);
  }

  const response = await fetch(record.fileUrl);
  if (!response.ok) {
    throw new AppError('Medical file storage service unavailable', 502);
  }

  const contentType = response.headers.get('content-type') || record.mimeType || 'application/octet-stream';
  res.set('Content-Type', contentType);
  res.set('Cache-Control', 'private, no-store');
  if (record.fileName) {
    res.set('Content-Disposition', `inline; filename="${String(record.fileName).replace(/"/g, '')}"`);
  }

  const body = Buffer.from(await response.arrayBuffer());
  return res.status(200).send(body);
};

const hasHospitalAccessToPatient = async (hospitalId, patientId) => {
  const [assignedRequest, sharedRecord] = await Promise.all([
    EmergencyRequest.exists({ userId: patientId, assignedHospital: hospitalId }),
    MedicalRecord.exists({
      userId: patientId,
      sharedWith: {
        $elemMatch: {
          hospitalId,
          expiresAt: { $gt: new Date() },
        },
      },
    }),
  ]);

  return !!assignedRequest || !!sharedRecord;
};

const canViewRecord = async (user, record) => {
  if (String(user._id) === String(record.userId)) return true;
  if (user.role !== ROLES.HOSPITAL) return false;

  const activeShare = (record.sharedWith || []).some(
    (share) => String(share.hospitalId) === String(user._id) && new Date(share.expiresAt) > new Date()
  );
  if (activeShare) return true;

  return hasHospitalAccessToPatient(user._id, record.userId);
};

const toClientRecord = (record) => {
  const { fileUrl, sharedWith, ...safeRecord } = record.toObject ? record.toObject() : record;
  const id = record._id || record.id;
  return {
    ...safeRecord,
    viewUrl: `/api/medical/record/${id}/view`,
  };
};

// POST /api/medical/upload
exports.uploadMedicalRecord = async (req, res, next) => {
  try {
    if (!req.file) throw new AppError('Please upload a file', 400);

    if (req.file.size > MAX_FILE_SIZE) {
      await fs.unlink(req.file.path).catch(() => {});
      throw new AppError(`File exceeds the ${MAX_FILE_SIZE / (1024 * 1024)} MB limit`, 400);
    }

    if (!ALLOWED_MIME_TYPES.has(req.file.mimetype)) {
      await fs.unlink(req.file.path).catch(() => {});
      throw new AppError('Only JPEG, PNG, GIF images and PDF files are allowed', 400);
    }

    const fileType = req.file.mimetype.startsWith('image/') ? 'image' : 'pdf';
    const resourceType = fileType === 'pdf' ? 'raw' : 'image';

    let uploadResult;
    try {
      uploadResult = await cloudinary.uploader.upload(req.file.path, {
        folder: `medical-records/${req.user._id}`,
        resource_type: resourceType,
        type: 'authenticated',
        public_id: `${Date.now()}-${path.parse(req.file.originalname).name}`,
        tags: [`user-${req.user._id}`, fileType],
      });
    } catch (cloudErr) {
      console.error('[Medical] Cloudinary upload error:', cloudErr.message);
      await fs.unlink(req.file.path).catch(() => {});
      throw new AppError('File storage service unavailable — please try again', 503);
    }

    await fs.unlink(req.file.path).catch((err) =>
      console.warn('[Medical] Failed to delete temp file:', err.message)
    );

    const record = await MedicalRecord.create({
      userId: req.user._id,
      recordType: fileType,
      fileUrl: uploadResult.secure_url,
      filePublicId: uploadResult.public_id,
      fileName: req.file.originalname,
      fileSize: req.file.size,
      fileType: fileType,
      mimeType: req.file.mimetype,
    });

    res.status(201).json({ success: true, data: toClientRecord(record) });
  } catch (err) {
    if (req.file?.path) {
      await fs.unlink(req.file.path).catch(() => {});
    }
    next(err);
  }
};

// GET /api/medical/:userId
exports.getMedicalRecords = async (req, res, next) => {
  try {
    const { userId } = req.params;
    const { type, limit = 50, page = 1 } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, parseInt(limit, 10) || 50);
    const skip = (pageNum - 1) * limitNum;

    if (req.user.role === ROLES.HOSPITAL) {
      const hasAccess = await hasHospitalAccessToPatient(req.user._id, userId);
      if (!hasAccess) throw new AppError('Not authorised to view these records', 403);
    } else if (String(req.user._id) !== userId) {
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
        .select('-sharedWith.accessToken')
        .sort('-createdAt')
        .skip(skip)
        .limit(limitNum)
        .lean(),
      MedicalRecord.countDocuments(query),
    ]);

    res.status(200).json({
      success: true,
      count: records.length,
      total,
      page: pageNum,
      pages: Math.ceil(total / limitNum),
      data: records.map(toClientRecord),
      patient: { id: user._id, name: user.name },
    });
  } catch (err) {
    next(err);
  }
};

// GET /api/medical/record/:id
exports.getMedicalRecord = async (req, res, next) => {
  try {
    const record = await MedicalRecord.findById(req.params.id)
      .select('-sharedWith.accessToken')
      .lean();

    if (!record) throw new AppError('Medical record not found', 404);

    if (!(await canViewRecord(req.user, record))) {
      throw new AppError('Not authorised to view this record', 403);
    }

    res.status(200).json({ success: true, data: toClientRecord(record) });
  } catch (err) {
    next(err);
  }
};

// GET /api/medical/record/:id/view
exports.viewMedicalRecordFile = async (req, res, next) => {
  try {
    const record = await MedicalRecord.findById(req.params.id)
      .select('-sharedWith.accessToken')
      .lean();

    if (!record) throw new AppError('Medical record not found', 404);
    if (!(await canViewRecord(req.user, record))) {
      throw new AppError('Not authorised to view this record', 403);
    }
    if (!record.fileUrl) throw new AppError('File URL not found', 404);

    const signedUrl = getSignedCloudinaryUrl(record);
    if (signedUrl) {
      return res.redirect(302, signedUrl);
    }

    return streamStoredMedicalFile(record, res);
  } catch (err) {
    next(err);
  }
};

// DELETE /api/medical/record/:id
exports.deleteMedicalRecord = async (req, res, next) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const record = await MedicalRecord.findById(req.params.id).session(session);
    if (!record) throw new AppError('Medical record not found', 404);

    if (String(record.userId) !== String(req.user._id)) {
      throw new AppError('Not authorised to delete this record', 403);
    }

    if (record.filePublicId) {
      try {
        const resourceType = record.fileType === 'pdf' ? 'raw' : 'image';
        await cloudinary.uploader.destroy(record.filePublicId, { 
          invalidate: true,
          type: 'authenticated',
          resource_type: resourceType 
        });
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

// POST /api/medical/share/:recordId
exports.shareMedicalRecord = async (req, res, next) => {
  try {
    const { recordId } = req.params;
    const { hospitalId, expiryHours = 24 } = req.body;

    if (!hospitalId) throw new AppError('hospitalId is required', 400);

    const hours = Math.min(168, Math.max(1, parseInt(expiryHours, 10) || 24));

    const record = await MedicalRecord.findById(recordId);
    if (!record) throw new AppError('Medical record not found', 404);

    if (String(record.userId) !== String(req.user._id)) {
      throw new AppError('Not authorised to share this record', 403);
    }

    const hospital = await User.findOne({ _id: hospitalId, role: ROLES.HOSPITAL }).lean();
    if (!hospital) throw new AppError('Hospital not found', 404);

    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + hours);

    record.sharedWith = (record.sharedWith || []).filter(
      (s) => String(s.hospitalId) !== String(hospitalId)
    );
    record.sharedWith.push({
      hospitalId,
      sharedAt: new Date(),
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
