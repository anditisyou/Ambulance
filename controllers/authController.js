'use strict';

const jwt          = require('jsonwebtoken');
const User         = require('../models/User');
const { ROLES }    = require('../utils/constants');
const { revokeToken } = require('../middleware/auth');
const AppError     = require('../utils/AppError');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Sign a JWT for the given user _id.
 * @param {import('mongoose').Types.ObjectId} id
 * @returns {string}
 */
const generateToken = (id) =>
  jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRE || '7d',
  });

/**
 * Set an httpOnly cookie and return the serialised cookie options.
 * @param {import('express').Response} res
 * @param {string} token
 */
const setTokenCookie = (res, token) => {
  res.cookie('token', token, {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'strict',                              // FIX: missing in original logout handler
    maxAge:   7 * 24 * 60 * 60 * 1000,              // 7 days in ms
  });
};

// ─── Controllers ─────────────────────────────────────────────────────────────

/**
 * @desc  Register a new user
 * @route POST /api/auth/register
 * @access Public
 */
exports.register = async (req, res, next) => {
  try {
    const { name, phone, email, role, password } = req.body;

    // ── Input presence ──
    if (!name || !email || !phone || !password) {
      throw new AppError('name, email, phone, and password are required', 400);
    }

    // ── Email format ──
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new AppError('Please provide a valid email address', 400);
    }

    // ── Phone format (E.164) ──
    if (!/^\+?[1-9]\d{1,14}$/.test(phone)) {
      throw new AppError('Please provide a valid phone number (E.164 format)', 400);
    }

    // ── Password strength ──
    if (!/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/.test(password)) {
      throw new AppError(
        'Password must be ≥8 chars with uppercase, lowercase, digit, and special character',
        400
      );
    }

    // ── Uniqueness check ──
    const existing = await User.findOne({
      $or: [{ email: email.toLowerCase().trim() }, { phone: phone.trim() }],
    });
    if (existing) {
      throw new AppError('An account with this email or phone already exists', 400);
    }

    // ── Role sanitisation — users cannot self-assign privileged roles ──
    const allowedSelfRoles = [ROLES.CITIZEN, ROLES.DRIVER, ROLES.HOSPITAL];
    const userRole = allowedSelfRoles.includes(role) ? role : ROLES.CITIZEN;

    const user = await User.create({
      name:     name.trim(),
      email:    email.toLowerCase().trim(),
      phone:    phone.trim(),
      role:     userRole,
      password,
    });

    const token = generateToken(user._id);
    setTokenCookie(res, token);

    res.status(201).json({
      success: true,
      token,
      user: { id: user._id, name: user.name, email: user.email, phone: user.phone, role: user.role },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * @desc  Login user by email or phone
 * @route POST /api/auth/login
 * @access Public
 */
exports.login = async (req, res, next) => {
  try {
    const { phone, email, password } = req.body;

    if ((!phone && !email) || !password) {
      throw new AppError('Please provide email/phone and password', 400);
    }

    // Build query — prefer phone over email if both supplied
    const query = phone
      ? { phone: phone.trim() }
      : { email: email.toLowerCase().trim() };

    const user = await User.findOne(query).select('+password');

    // Generic message prevents user enumeration
    if (!user || !(await user.comparePassword(password))) {
      throw new AppError('Invalid credentials', 401);
    }

    if (!user.isActive) {
      throw new AppError('Account is deactivated', 401);
    }

    const token = generateToken(user._id);
    setTokenCookie(res, token);

    res.status(200).json({
      success: true,
      token,
      user: { id: user._id, name: user.name, email: user.email, phone: user.phone, role: user.role },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * @desc  Get current authenticated user
 * @route GET /api/auth/me
 * @access Private
 */
exports.getMe = async (req, res, next) => {
  try {
    // req.user is already populated by protect middleware (without password)
    res.status(200).json({ success: true, user: req.user });
  } catch (err) {
    next(err);
  }
};

/**
 * @desc  Logout — revoke token and clear cookie
 * @route POST /api/auth/logout
 * @access Private
 */
exports.logout = async (req, res, next) => {
  try {
    // FIX: original used `split(' ')[1]` which is correct but checked
    //      `startsWith('Bearer')` without the trailing space — could match 'BearerXYZ'.
    const auth = req.headers.authorization;
    const token =
      auth?.startsWith('Bearer ') ? auth.slice(7) : req.cookies?.token || null;

    if (token) {
      await revokeToken(token);
    }

    // Clear cookie — expire immediately
    res.clearCookie('token', {
      httpOnly: true,
      secure:   process.env.NODE_ENV === 'production',
      sameSite: 'strict',
    });

    res.status(200).json({ success: true, message: 'Logged out successfully' });
  } catch (err) {
    next(err);
  }
};
