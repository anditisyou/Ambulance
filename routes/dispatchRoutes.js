'use strict';
const express      = require('express');
const router       = express.Router();
const ctrl         = require('../controllers/dispatchController');
const { protect }  = require('../middleware/auth');
const { authorize } = require('../middleware/role');
const { ROLES }    = require('../utils/constants');

router.use(protect);

router.post('/request',         authorize(ROLES.CITIZEN),  ctrl.newRequest);
router.get('/active',           authorize(ROLES.CITIZEN),  ctrl.getActive);
router.get('/assignments',      authorize(ROLES.DRIVER),   ctrl.getAssignments);
router.put('/:id/response',     authorize(ROLES.DRIVER),   ctrl.driverResponse);
router.patch('/:id/track',      authorize(ROLES.DRIVER),   ctrl.track);
router.delete('/:id',           authorize(ROLES.CITIZEN),  ctrl.cancelRequest);

module.exports = router;
