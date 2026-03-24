'use strict';
const express      = require('express');
const router       = express.Router();
const ctrl         = require('../controllers/adminController');
const { protect }  = require('../middleware/auth');
const { authorize } = require('../middleware/role');
const { ROLES }    = require('../utils/constants');

router.use(protect, authorize(ROLES.ADMIN));

router.get('/users',               ctrl.getAllUsers);
router.get('/users/:id',           ctrl.getUserById);
router.put('/users/:id/role',      ctrl.updateUserRole);
router.delete('/users/:id',        ctrl.deleteUser);
router.get('/ambulances',          ctrl.getAllAmbulances);
router.get('/stats',               ctrl.getSystemStats);

module.exports = router;
