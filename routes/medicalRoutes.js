'use strict';
const express      = require('express');
const multer       = require('multer');
const path         = require('path');
const os           = require('os');
const router       = express.Router();
const ctrl         = require('../controllers/medicalController');
const { protect }  = require('../middleware/auth');
const { authorize } = require('../middleware/role');
const { ROLES }    = require('../utils/constants');

// Store uploads in OS temp dir — Cloudinary will pull from here
const upload = multer({
  dest:   os.tmpdir(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB hard cap at multer level
  fileFilter: (_req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.gif', '.pdf'];
    const ext     = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) return cb(null, true);
    cb(new Error('Invalid file type'), false);
  },
});

router.use(protect);

router.post('/upload',               upload.single('file'), ctrl.uploadMedicalRecord);
router.get('/:userId',               authorize(ROLES.HOSPITAL, ROLES.CITIZEN), ctrl.getMedicalRecords);
router.get('/record/:id',            authorize(ROLES.HOSPITAL, ROLES.CITIZEN), ctrl.getMedicalRecord);
router.delete('/record/:id',         ctrl.deleteMedicalRecord);
router.post('/share/:recordId',      ctrl.shareMedicalRecord);

module.exports = router;
