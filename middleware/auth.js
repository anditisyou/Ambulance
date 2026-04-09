'use strict';

const jwt       = require('jsonwebtoken');
const User      = require('../models/User');
const AppError  = require('../utils/AppError');
const redisClient = require('../utils/redisClient');

/**
 * In-memory fallback token blacklist (used when Redis is unavailable).
 * NOTE: Does NOT survive server restarts and is NOT shared across instances.
 *       Always deploy Redis in multi-instance production environments.
 */
const memoryBlacklist = new Set();

const isRedisConnected = () =>
  redisClient &&
  typeof redisClient.get === 'function' &&
  redisClient.status === 'ready';

const warnRedisFallback = (() => {
  let emitted = false;
  return () => {
    if (!emitted) {
      emitted = true;
      console.warn('[Auth] Redis is not ready — using in-memory blacklist fallback');
    }
  };
})();

if (!redisClient) {
  console.warn('[Auth] Redis client unavailable — using in-memory token blacklist');
}

// ─── Token revocation ─────────────────────────────────────────────────────────

/**
 * Add a JWT to the blacklist so it cannot be reused after logout / password change.
 *
 * @param {string} token - Raw JWT string
 * @returns {Promise<boolean>}
 */
const revokeToken = async (token) => {
  if (!token) return false;

  try {
    const decoded = jwt.decode(token);
    if (!decoded?.exp) return false;

    const ttl = decoded.exp - Math.floor(Date.now() / 1000);
    if (ttl <= 0) return true; // already expired — no-op

    if (isRedisConnected()) {
      try {
        await redisClient.setex(`bl:${token}`, ttl, '1');
      } catch (err) {
        console.warn('[Auth] Redis write failed — falling back to in-memory blacklist:', err.message);
        memoryBlacklist.add(token);
        setTimeout(() => memoryBlacklist.delete(token), ttl * 1000);
      }
    } else {
      warnRedisFallback();
      memoryBlacklist.add(token);
      setTimeout(() => memoryBlacklist.delete(token), ttl * 1000);
    }

    return true;
  } catch (err) {
    console.error('[Auth] revokeToken error:', err.message);
    return false;
  }
};

/**
 * @param {string} token
 * @returns {Promise<boolean>} true if token has been revoked
 */
const isTokenRevoked = async (token) => {
  if (!token) return true;

  try {
    if (isRedisConnected()) {
      const result = await redisClient.get(`bl:${token}`);
      return !!result;
    }

    warnRedisFallback();
    return memoryBlacklist.has(token);
  } catch (err) {
    console.error('[Auth] isTokenRevoked error:', err.message);
    return memoryBlacklist.has(token);
  }
};

// ─── Token extraction ─────────────────────────────────────────────────────────

/**
 * Extract bearer token from Authorization header or httpOnly cookie.
 * Query-param tokens are intentionally NOT supported (security risk).
 *
 * @param {import('express').Request} req
 * @returns {string|null}
 */
const extractToken = (req) => {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  if (req.cookies?.token) return req.cookies.token;
  return null;
};

// ─── Middleware ───────────────────────────────────────────────────────────────

/**
 * protect — require a valid, non-revoked JWT.
 * Attaches `req.user` (without password) and `req.token`.
 */
const protect = async (req, res, next) => {
  try {
    // 1. Extract
    const token = extractToken(req);
    if (!token) throw new AppError('Not authorised — no token provided', 401);

    // 2. Revocation check BEFORE expensive DB lookup
    if (await isTokenRevoked(token)) {
      throw new AppError('Token revoked — please log in again', 401);
    }

    // 3. Verify signature + expiry
    if (!process.env.JWT_SECRET) {
      console.error('[Auth] JWT_SECRET environment variable is missing');
      throw new AppError('Server configuration error', 500);
    }

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (jwtErr) {
      const msg =
        jwtErr.name === 'TokenExpiredError'
          ? 'Token expired — please log in again'
          : 'Invalid token';
      throw new AppError(msg, 401);
    }

    if (!decoded?.id) throw new AppError('Invalid token payload', 401);

    // 4. Fetch user (excludes password via schema `select: false`)
    const user = await User.findById(decoded.id);
    if (!user)            throw new AppError('User no longer exists', 401);
    if (!user.isActive)   throw new AppError('Account is deactivated', 401);

    req.user     = user;
    req.userId   = user._id;
    req.userRole = user.role;
    req.token    = token;
    next();
  } catch (err) {
    next(err);
  }
};

/**
 * optionalAuth — attaches user if token present and valid, otherwise continues.
 */
const optionalAuth = async (req, res, next) => {
  try {
    const token = extractToken(req);
    if (token && process.env.JWT_SECRET) {
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (decoded?.id) {
          const user = await User.findById(decoded.id);
          if (user?.isActive) {
            req.user = user;
            req.userId = user._id;
            req.userRole = user.role;
          }
        }
      } catch (_) {
        // silent — invalid token just means unauthenticated
      }
    }
  } catch (_) {
    // Never let optional auth break the request
  }
  next();
};

/**
 * refreshToken — issue a new JWT, revoke the old one.
 * Uses `ignoreExpiration: true` so recently-expired tokens can still be refreshed.
 */
const refreshToken = async (req, res, next) => {
  try {
    const oldToken = extractToken(req);
    if (!oldToken) throw new AppError('No token provided', 401);

    if (await isTokenRevoked(oldToken)) {
      throw new AppError('Token revoked', 401);
    }

    let decoded;
    try {
      decoded = jwt.verify(oldToken, process.env.JWT_SECRET, { ignoreExpiration: true });
    } catch (_) {
      throw new AppError('Invalid token', 401);
    }

    const user = await User.findById(decoded.id);
    if (!user || !user.isActive) throw new AppError('User not found or inactive', 401);

    const newToken = jwt.sign({ id: user._id }, process.env.JWT_SECRET, {
      expiresIn: process.env.JWT_EXPIRE || '7d',
    });

    // Revoke old token concurrently while responding
    await revokeToken(oldToken);

    res.cookie('token', newToken, {
      httpOnly: true,
      secure:   process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge:   7 * 24 * 60 * 60 * 1000,
    });

    res.status(200).json({
      success: true,
      token:   newToken,
      user: { id: user._id, name: user.name, role: user.role },
    });
  } catch (err) {
    next(err);
  }
};

const authJwt = protect;

module.exports = { protect, optionalAuth, refreshToken, revokeToken, isTokenRevoked, authJwt };
