'use strict';
const express      = require('express');
const router       = express.Router();
const ctrl         = require('../controllers/analyticsController');
const { protect }  = require('../middleware/auth');
const { authorize } = require('../middleware/role');
const { ROLES }    = require('../utils/constants');

router.use(protect, authorize(ROLES.ADMIN));

router.get('/latency',     ctrl.getLatencyMetrics);
router.get('/performance', ctrl.getPerformanceMetrics);
router.get('/export',      ctrl.exportAnalytics);

module.exports = router;
