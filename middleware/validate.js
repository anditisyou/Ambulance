'use strict';

const AppError = require('../utils/AppError');

/**
 * Lightweight request validator.
 *
 * Usage:
 *   router.post('/login', validate({
 *     body: { required: ['email', 'password'] }
 *   }), ctrl.login);
 *
 * Supported rules per source (body | params | query):
 *   required   {string[]}  — fields that must be present and non-empty
 *   optional   {string[]}  — fields documented but not enforced (no-op)
 *   maxLength  {Object}    — { fieldName: maxChars }
 *   isNumeric  {string[]}  — fields that must be parseable as finite numbers
 *   isMongoId  {string[]}  — fields that must look like MongoDB ObjectIds
 */

const MONGO_ID_RE = /^[a-f\d]{24}$/i;

const validate = (rules = {}) => (req, res, next) => {
  try {
    const sources = { body: req.body, params: req.params, query: req.query };

    for (const [source, sourceRules] of Object.entries(rules)) {
      const data = sources[source] || {};

      // ── Required fields ──
      if (sourceRules.required) {
        for (const field of sourceRules.required) {
          if (data[field] === undefined || data[field] === null || data[field] === '') {
            throw new AppError(`"${field}" is required`, 400);
          }
        }
      }

      // ── Max length ──
      if (sourceRules.maxLength) {
        for (const [field, max] of Object.entries(sourceRules.maxLength)) {
          if (data[field] && String(data[field]).length > max) {
            throw new AppError(`"${field}" must not exceed ${max} characters`, 400);
          }
        }
      }

      // ── Numeric ──
      if (sourceRules.isNumeric) {
        for (const field of sourceRules.isNumeric) {
          if (data[field] !== undefined && !isFinite(parseFloat(data[field]))) {
            throw new AppError(`"${field}" must be a valid number`, 400);
          }
        }
      }

      // ── MongoDB ObjectId ──
      if (sourceRules.isMongoId) {
        for (const field of sourceRules.isMongoId) {
          if (data[field] !== undefined && !MONGO_ID_RE.test(data[field])) {
            throw new AppError(`"${field}" must be a valid ID`, 400);
          }
        }
      }
    }

    next();
  } catch (err) {
    next(err);
  }
};

module.exports = { validate };
