'use strict';

const AppError = require('../utils/AppError');

// ─── Mongoose / JWT error translators ────────────────────────────────────────

/**
 * Cast error — invalid MongoDB ObjectId (e.g. /api/users/not-an-id)
 */
const handleCastError = (err) =>
  new AppError(`Invalid ${err.path}: ${err.value}`, 400);

/**
 * MongoDB duplicate key error (E11000)
 */
const handleDuplicateKey = (err) => {
  const field = Object.keys(err.keyValue || {})[0] || 'field';
  const value = err.keyValue?.[field];
  return new AppError(
    `Duplicate value for ${field}: "${value}". Please use a different value.`,
    400
  );
};

/**
 * Mongoose validation error (schema-level)
 */
const handleValidationError = (err) => {
  const messages = Object.values(err.errors).map((e) => e.message);
  return new AppError(`Validation failed: ${messages.join('. ')}`, 400);
};

/**
 * JWT errors — already handled inline in auth.js, but catch any that leak here.
 */
const handleJWTError = () =>
  new AppError('Invalid authentication token — please log in again.', 401);

const handleJWTExpired = () =>
  new AppError('Authentication token expired — please log in again.', 401);

// ─── Development vs Production response formatters ────────────────────────────

const sendDevError = (err, res) => {
  res.status(err.statusCode).json({
    success:    false,
    status:     err.status,
    message:    err.message,
    stack:      err.stack,
    error:      err,
  });
};

const sendProdError = (err, res) => {
  if (err.isOperational) {
    // Known, safe-to-expose operational error
    res.status(err.statusCode).json({
      success: false,
      status:  err.status,
      message: err.message,
      ...(err.code && { code: err.code }),
    });
  } else {
    // Unknown programming error — don't leak details
    console.error('[ERROR] Non-operational error:', err);
    res.status(500).json({
      success: false,
      status:  'error',
      message: 'Something went wrong. Please try again later.',
    });
  }
};

// ─── Main error-handling middleware ───────────────────────────────────────────

/**
 * Global Express error handler.
 * Must be registered LAST with `app.use(globalErrorHandler)`.
 * The 4-argument signature is required by Express.
 */
// eslint-disable-next-line no-unused-vars
const globalErrorHandler = (err, req, res, next) => {
  err.statusCode = err.statusCode || 500;
  err.status     = err.status     || 'error';

  if (process.env.NODE_ENV === 'development') {
    return sendDevError(err, res);
  }

  // Translate known non-operational errors into friendly AppErrors
  let error = Object.assign(Object.create(Object.getPrototypeOf(err)), err);

  if (error.name === 'CastError')             error = handleCastError(error);
  if (error.code === 11000)                   error = handleDuplicateKey(error);
  if (error.name === 'ValidationError')       error = handleValidationError(error);
  if (error.name === 'JsonWebTokenError')     error = handleJWTError();
  if (error.name === 'TokenExpiredError')     error = handleJWTExpired();
  if (error.name === 'MulterError') {
    error = new AppError(`File upload error: ${error.message}`, 400);
  }

  sendProdError(error, res);
};

module.exports = globalErrorHandler;
