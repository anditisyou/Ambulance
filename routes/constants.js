'use strict';

const express = require('express');
const router  = express.Router();
const cache   = require('../utils/cache');

const {
  ROLES,
  REQUEST_STATUS,
  REQUEST_PRIORITY,
  REQUEST_TYPES,
  AMBULANCE_STATUS,
} = require('../utils/constants');

// GET /api/constants
// Returns all enums so the frontend can stay in sync with the server
// Cached for 1 hour since constants rarely change

router.get('/', cache.middleware(3600), (req, res) => {
  res.json({
    success: true,
    data: {
      REQUEST_STATUS,
      AMBULANCE_STATUS,
      ROLES,
    },
  });
});

module.exports = router;