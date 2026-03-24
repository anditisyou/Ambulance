'use strict';

const express = require('express');
const router  = express.Router();

const authController = require('../controllers/authController');
const { protect }    = require('../middleware/auth');
const { refreshToken } = require('../middleware/auth');

// Public routes
router.post('/register', authController.register);
router.post('/login',    authController.login);

// Private routes
router.use(protect);
router.get('/me',       authController.getMe);
router.post('/logout',  authController.logout);
router.post('/refresh', refreshToken);

module.exports = router;
