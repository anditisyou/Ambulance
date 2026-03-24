'use strict';

const express = require('express');
const router  = express.Router();

const {
  ROLES,
  REQUEST_STATUS,
  REQUEST_PRIORITY,
  REQUEST_TYPES,
  AMBULANCE_STATUS,
} = require('../utils/constants');

// GET /api/constants
// Returns all enums so the frontend can stay in sync with the server
router.get('/', (req, res) => {
  res.json({
    success: true,
    data: {
      ROLES,
      REQUEST_STATUS,
      REQUEST_PRIORITY,
      REQUEST_TYPES,
      AMBULANCE_STATUS,
    }
  });
});

module.exports = router;