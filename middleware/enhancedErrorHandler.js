'use strict';

const logger = require('../utils/logger');
const AppError = require('../utils/AppError');

/**
 * ENHANCED ERROR HANDLER MIDDLEWARE
 * 
 * Safety Features:
 * - No sensitive data in production error responses
 * - Stack traces only in development
 * - Structured error logging
 * - Automatic error classification
 * - Database error normalization
 * - Graceful fallback responses
 */

// Categorize errors for appropriate response
const classifyError = (err) => {
  if (err.isOperational) return 'operational';
  if (err.name === 'ValidationError') return 'validation';
  if (err.name === 'CastError') return 'cast';
  if (err.name === 'MongooseOperationalError') return 'database';
  if (err.name === 'JsonWebTokenError') return 'auth';
  if (err.name === 'TokenExpiredError') return 'auth';
  return 'programming';
};

// Mask sensitive data in error messages
const maskSensitiveData = (value) => {
  if (value === null || value === undefined) return value;

  if (typeof value === 'object') {
    if (Array.isArray(value)) return value.map(maskSensitiveData);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      const sensitive = /password|token|jwt|api[_-]?key|secret|credential/i.test(key);
      return [key, sensitive ? '***REDACTED***' : maskSensitiveData(item)];
    }));
  }

  return String(value)
    .replace(/password[:\s=]+"[^"]*"/gi, 'password: "***"')
    .replace(/token[:\s=]+"[^"]*"/gi, 'token: "***"')
    .replace(/jwt[:\s=]+"[^"]*"/gi, 'jwt: "***"')
    .replace(/api[_-]?key[:\s=]+"[^"]*"/gi, 'api_key: "***"')
    .replace(/secret[:\s=]+"[^"]*"/gi, 'secret: "***"')
    .replace(/credential[:\s=]+"[^"]*"/gi, 'credential: "***"')
    .replace(/email[:\s=]+"[^"]*@[^"]*"/gi, 'email: "***@***"')
    .replace(/phone[:\s=]+"\+?[\d\s-]*"/gi, 'phone: "***"');
};

const sendDevError = (err, res) => {
  res.status(err.statusCode || 500).json({
    success: false,
    status: err.status || 'error',
    message: maskSensitiveData(err.message),
    error: {
      name: err.name,
      statusCode: err.statusCode,
      isOperational: err.isOperational,
      stack: err.stack,
      details: err.details
    }
  });
};

const sendProdError = (err, res) => {
  // Operational errors: trusted, safe to send to client
  if (err.isOperational) {
    return res.status(err.statusCode).json({
      success: false,
      status: err.status,
      message: maskSensitiveData(err.message),
      requestId: res.locals.requestId
    });
  }

  // Programming or unknown errors: don't leak details
  logger.error('Unhandled error', {
    error: err.message,
    stack: err.stack,
    name: err.name,
    statusCode: err.statusCode,
    requestId: res.locals.requestId
  });

  res.status(500).json({
    success: false,
    status: 'error',
    message: 'An unexpected error occurred. Please try again later.',
    requestId: res.locals.requestId
  });
};

/**
 * Enhanced error handler - always call next() with error to reach this
 * Example: next(new AppError('Not found', 404))
 */
const errorHandler = (err, req, res, next) => {
  err.statusCode = err.statusCode || 500;
  err.status = err.status || 'error';

  const errorType = classifyError(err);
  const isDev = process.env.NODE_ENV !== 'production';

  // Log error with context
  const logLevel = err.statusCode >= 500 ? 'error' : 'warn';
  logger[logLevel](`${errorType.toUpperCase()} ERROR`, {
    method: req.method,
    path: req.path,
    statusCode: err.statusCode,
    message: err.message,
    errorType,
    requestId: res.locals.requestId,
    userId: req.user?._id,
    userRole: req.user?.role,
    query: req.query,
    ip: req.ip,
    userAgent: req.get('user-agent'),
    ...(isDev && { stack: err.stack })
  });

  // Handle specific error types
  if (err.name === 'ValidationError') {
    err = handleValidationError(err);
  } else if (err.name === 'CastError') {
    err = handleCastError(err);
  } else if (err.name === 'MongoError' && err.code === 11000) {
    err = handleDuplicateKey(err);
  } else if (err.name === 'JsonWebTokenError') {
    err = handleJWTError(err);
  } else if (err.name === 'TokenExpiredError') {
    err = handleJWTExpired(err);
  }

  // Send appropriate response based on environment
  if (isDev) {
    sendDevError(err, res);
  } else {
    sendProdError(err, res);
  }
};

/**
 * Error handler utilities
 */

const handleValidationError = (err) => {
  const messages = Object.values(err.errors)
    .map(e => e.message)
    .join('; ');
  
  return new AppError(`Validation Error: ${messages}`, 400);
};

const handleCastError = (err) => {
  return new AppError(`Invalid ${err.path}: ${err.value}`, 400);
};

const handleDuplicateKey = (err) => {
  const field = Object.keys(err.keyValue)[0] || 'field';
  return new AppError(
    `Duplicate value for '${field}'. Please use a different value.`,
    400
  );
};

const handleJWTError = (err) => {
  return new AppError('Invalid authentication token. Please log in again.', 401);
};

const handleJWTExpired = (err) => {
  return new AppError('Authentication token expired. Please log in again.', 401);
};

/**
 * Async error wrapper - catches errors in async route handlers
 * Usage: router.get('/path', catchAsync(async (req, res) => { ... }))
 */
const catchAsync = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

/**
 * Global error boundary for unhandled rejections
 */
const setupErrorBoundary = () => {
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', {
      reason: String(reason),
      stack: reason instanceof Error ? reason.stack : 'No stack trace'
    });
  });

  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception', {
      message: err.message,
      stack: err.stack
    });
  });
};

module.exports = {
  errorHandler,
  catchAsync,
  setupErrorBoundary,
  maskSensitiveData,
  classifyError
};
