'use strict';

/**
 * Custom operational error class.
 * Distinguishes user-facing errors from unexpected programmer bugs.
 */
class AppError extends Error {
  /**
   * @param {string}  message    - Human-readable error message.
   * @param {number}  statusCode - HTTP status code (4xx / 5xx).
   * @param {string}  [code]     - Optional machine-readable error code.
   */
  constructor(message, statusCode, code) {
    super(message);
    this.statusCode = statusCode;
    this.status     = `${statusCode}`.startsWith('4') ? 'fail' : 'error';
    this.isOperational = true;
    this.code = code || null;

    // Preserves proper stack trace in V8
    Error.captureStackTrace(this, this.constructor);
  }
}

module.exports = AppError;
