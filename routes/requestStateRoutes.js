'use strict';

const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/requestStateController');
const { protect } = require('../middleware/auth');
const { authorize } = require('../middleware/role');
const { ROLES } = require('../utils/constants');

router.use(protect);

// Driver workflow
router.post('/:requestId/accept', authorize(ROLES.DRIVER), ctrl.acceptAssignment);
router.post('/:requestId/reject', authorize(ROLES.DRIVER), ctrl.rejectAssignment);
router.post('/:requestId/en-route', authorize(ROLES.DRIVER), ctrl.markEnRoute);

// Get state with audit trail
router.get('/:requestId/state', authorize(ROLES.ADMIN, ROLES.DISPATCHER, ROLES.DRIVER, ROLES.HOSPITAL, ROLES.CITIZEN), ctrl.getRequestState);

module.exports = router;