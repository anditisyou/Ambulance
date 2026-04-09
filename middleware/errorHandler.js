'use strict';

const AppError = require('../utils/AppError');

const handleCastError = (err) =>
  new AppError(`Invalid ${err.path}: ${err.value}`, 400);

const handleDuplicateKey = (err) => {
  const field = Object.keys(err.keyValue || {})[0] || 'field';
  const value = err.keyValue?.[field];
  return new AppError(
    `Duplicate value for ${field}: "${value}". Please use a different value.`,
    400
  );
};

const handleValidationError = (err) => {
  const messages = Object.values(err.errors).map((e) => e.message);
  return new AppError(`Validation failed: ${messages.join('. ')}`, 400);
};

const handleJWTError = () =>
  new AppError('Invalid authentication token - please log in again.', 401);

const handleJWTExpired = () =>
  new AppError('Authentication token expired - please log in again.', 401);

const handleMongooseOperationalError = (err) => {
  const transientNames = new Set([
    'MongooseError',
    'MongoServerSelectionError',
    'MongoNetworkError',
    'MongoServerError',
  ]);

  if (transientNames.has(err.name)) {
    return new AppError('Database temporarily unavailable. Please retry shortly.', 503);
  }

  return err;
};

const sendDevError = (err, res) => {
  res.status(err.statusCode).json({
    success: false,
    status: err.status,
    message: err.message,
    stack: err.stack,
    error: err,
  });
};

const sendProdError = (err, res) => {
  if (err.isOperational) {
    res.status(err.statusCode).json({
      success: false,
      status: err.status,
      message: err.message,
      ...(err.code && { code: err.code }),
    });
  } else {
    console.error('[ERROR] Non-operational error:', err.name, err.message);
    if (err.stack) console.error(err.stack);
    res.status(500).json({
      success: false,
      status: 'error',
      message: 'Something went wrong. Please try again later.',
    });
  }
};

// eslint-disable-next-line no-unused-vars
const globalErrorHandler = (err, req, res, next) => {
  err.statusCode = err.statusCode || 500;
  err.status = err.status || 'error';

  if (process.env.NODE_ENV === 'development') {
    return sendDevError(err, res);
  }

  let error = Object.assign(Object.create(Object.getPrototypeOf(err)), err);

  if (error.name === 'CastError') error = handleCastError(error);
  if (error.code === 11000) error = handleDuplicateKey(error);
  if (error.name === 'ValidationError') error = handleValidationError(error);
  if (error.name === 'JsonWebTokenError') error = handleJWTError();
  if (error.name === 'TokenExpiredError') error = handleJWTExpired();
  error = handleMongooseOperationalError(error);
  if (error.name === 'MulterError') {
    error = new AppError(`File upload error: ${error.message}`, 400);
  }

  sendProdError(error, res);
};

module.exports = globalErrorHandler;
