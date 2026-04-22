'use strict';
// ── emergencyRoutes.js ────────────────────────────────────────────────────────
const express   = require('express');
const router    = express.Router();
const ctrl      = require('../controllers/emergencyController');
const dispatchCtrl = require('../controllers/dispatchController');
const { protect } = require('../middleware/auth');
const { authorize } = require('../middleware/role');
const { ROLES } = require('../utils/constants');
const rateLimit = require('express-rate-limit');

const emergencyRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // limit each IP to 5 emergency requests per windowMs
  message: 'Too many emergency requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user ? req.user._id.toString() : req.ip, // Rate limit per user, fallback to IP
});

router.use(protect);

router.get('/active',     authorize(ROLES.CITIZEN),                       dispatchCtrl.getActive);
router.get('/',           authorize(ROLES.ADMIN, ROLES.DISPATCHER, ROLES.HOSPITAL, ROLES.DRIVER, ROLES.CITIZEN), ctrl.getEmergencyRequests);
router.post('/',          authorize(ROLES.CITIZEN), emergencyRateLimit, ctrl.createEmergencyRequest);
router.get('/history',    authorize(ROLES.CITIZEN),                       ctrl.getRequestHistory);
router.get('/:id',        authorize(ROLES.ADMIN, ROLES.DISPATCHER, ROLES.HOSPITAL, ROLES.DRIVER, ROLES.CITIZEN), ctrl.getEmergencyRequest);
router.put('/:id/accept', authorize(ROLES.HOSPITAL),                      ctrl.acceptEmergencyRequest);
router.put('/:id/complete', authorize(ROLES.DRIVER),                      ctrl.completeEmergencyRequest);

module.exports = router;
