'use strict';
const express = require('express');
const multer = require('multer');
const path = require('path');
const os = require('os');
const router = express.Router();
const ctrl = require('../controllers/medicalController');
const { protect } = require('../middleware/auth');
const { authorize } = require('../middleware/role');
const { ROLES } = require('../utils/constants');

// Configure multer for temporary storage
const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.gif', '.pdf'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) return cb(null, true);
    cb(new Error('Invalid file type'), false);
  },
});

// All routes require authentication
router.use(protect);

// Upload routes
router.post('/upload', upload.single('file'), ctrl.uploadMedicalRecord);

// View routes
router.get('/record/:id', authorize(ROLES.HOSPITAL, ROLES.CITIZEN), ctrl.getMedicalRecord);
router.get('/user/:userId', authorize(ROLES.HOSPITAL, ROLES.CITIZEN), ctrl.getMedicalRecords);

// Delete route
router.delete('/record/:id', ctrl.deleteMedicalRecord);

// Share route
router.post('/share/:recordId', ctrl.shareMedicalRecord);

module.exports = router;