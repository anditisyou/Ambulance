'use strict';
// ── emergencyRoutes.js ────────────────────────────────────────────────────────
const express   = require('express');
const router    = express.Router();
const ctrl      = require('../controllers/emergencyController');
const { protect } = require('../middleware/auth');
const { authorize } = require('../middleware/role');
const { ROLES } = require('../utils/constants');

router.use(protect);

router.get('/',           authorize(ROLES.ADMIN, ROLES.DISPATCHER, ROLES.HOSPITAL, ROLES.DRIVER, ROLES.CITIZEN), ctrl.getEmergencyRequests);
router.post('/',          authorize(ROLES.CITIZEN),                       ctrl.createEmergencyRequest);
router.get('/history',    authorize(ROLES.CITIZEN),                       ctrl.getRequestHistory);
router.get('/:id',        authorize(ROLES.ADMIN, ROLES.DISPATCHER, ROLES.HOSPITAL, ROLES.DRIVER, ROLES.CITIZEN), ctrl.getEmergencyRequest);
router.put('/:id/accept', authorize(ROLES.HOSPITAL),                      ctrl.acceptEmergencyRequest);
router.put('/:id/complete', authorize(ROLES.DRIVER),                      ctrl.completeEmergencyRequest);

module.exports = router;
