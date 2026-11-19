'use strict';

const express = require('express');
const router  = express.Router();
const cache   = require('../utils/cache');

const {
  ROLES,
  ROLES_VALUES,
  REQUEST_STATUS,
  REQUEST_STATUS_VALUES,
  REQUEST_PRIORITY,
  REQUEST_PRIORITY_VALUES,
  REQUEST_TYPES,
  REQUEST_TYPES_VALUES,
  AMBULANCE_STATUS,
  AMBULANCE_STATUS_VALUES,
  DISPATCH_STATUS,
  DISPATCH_STATUS_VALUES,
  SLA_STATUS,
} = require('../utils/constants');

// GET /api/constants
// Returns all enums so the frontend can stay in sync with the server
// Cached for 1 hour since constants rarely change

router.get('/', cache.middleware(3600), (req, res) => {
  res.json({
    success: true,
    data: {
      ROLES,
      ROLES_VALUES,
      REQUEST_STATUS,
      REQUEST_STATUS_VALUES,
      REQUEST_PRIORITY,
      REQUEST_PRIORITY_VALUES,
      REQUEST_TYPES,
      REQUEST_TYPES_VALUES,
      AMBULANCE_STATUS,
      AMBULANCE_STATUS_VALUES,
      DISPATCH_STATUS,
      DISPATCH_STATUS_VALUES,
      SLA_STATUS,
    },
  });
});

module.exports = router;
