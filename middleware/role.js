'use strict';

const { ROLES } = require('../utils/constants');
const AppError  = require('../utils/AppError');

/**
 * authorize — allow access only to specific roles.
 * ADMIN implicitly passes all role checks.
 *
 * @param {...string} allowedRoles
 */
const authorize = (...allowedRoles) => (req, res, next) => {
  try {
    if (!req.user) throw new AppError('User not authenticated', 401);

    if (req.user.role === ROLES.ADMIN || allowedRoles.includes(req.user.role)) {
      return next();
    }

    throw new AppError(
      `Access denied. Required roles: ${allowedRoles.join(', ')}. Your role: ${req.user.role}`,
      403
    );
  } catch (err) {
    next(err);
  }
};

/**
 * authorizeOwner — allow access only to the resource owner (+ ADMIN).
 *
 * @param {(req: import('express').Request) => Promise<string|ObjectId>} getOwnerId
 */
const authorizeOwner = (getOwnerId) => async (req, res, next) => {
  try {
    if (!req.user) throw new AppError('User not authenticated', 401);
    if (req.user.role === ROLES.ADMIN) return next();

    const ownerId = await getOwnerId(req);
    if (!ownerId) throw new AppError('Resource owner not found', 404);

    if (String(req.user._id) !== String(ownerId)) {
      throw new AppError('Not authorised to access this resource', 403);
    }
    next();
  } catch (err) {
    next(err);
  }
};

/**
 * requireAllRoles — FIX: original logic checked `role === userRole` for every
 * required role, which is always false unless there's only one required role.
 * A single-role user can never satisfy multiple required roles; this is now
 * correctly rejected unless there is exactly one required role equal to the user's.
 *
 * Realistic use-case: reserved for future multi-role support.
 *
 * @param {...string} requiredRoles
 */
const requireAllRoles = (...requiredRoles) => (req, res, next) => {
  try {
    if (!req.user) throw new AppError('User not authenticated', 401);
    if (req.user.role === ROLES.ADMIN) return next();

    // A user has exactly ONE role; it must be present in every required role slot.
    // This is only meaningful when requiredRoles has exactly one entry — behaves
    // the same as `authorize` in that case.
    const userRole    = req.user.role;
    const hasAllRoles = requiredRoles.every((r) => r === userRole);

    if (!hasAllRoles) {
      throw new AppError(
        `Access denied. Requires all of: ${requiredRoles.join(', ')}`,
        403
      );
    }
    next();
  } catch (err) {
    next(err);
  }
};

const isAmbulance = authorize(ROLES.DRIVER);
const isHospital = authorize(ROLES.HOSPITAL);
const isAdmin = authorize(ROLES.ADMIN);

module.exports = { authorize, authorizeOwner, requireAllRoles, isAmbulance, isHospital, isAdmin };
