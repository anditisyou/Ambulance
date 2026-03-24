'use strict';
const express      = require('express');
const router       = express.Router();
const ctrl         = require('../controllers/ambulanceController');
const { protect }  = require('../middleware/auth');
const { authorize } = require('../middleware/role');
const { ROLES }    = require('../utils/constants');

router.use(protect);

router.post('/',                authorize(ROLES.DRIVER),                              ctrl.registerOrUpdate);
router.get('/',                 authorize(ROLES.ADMIN, ROLES.DISPATCHER, ROLES.DRIVER), ctrl.getAll);
router.get('/:id',              authorize(ROLES.ADMIN, ROLES.DISPATCHER, ROLES.DRIVER), ctrl.getById);
router.patch('/:id/status',     authorize(ROLES.ADMIN, ROLES.DRIVER),                ctrl.updateStatus);
router.patch('/:id/location',   authorize(ROLES.DRIVER),                             ctrl.updateLocation);

module.exports = router;
