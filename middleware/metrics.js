'use strict';

const { recordRequest } = require('../utils/metrics');

module.exports = (req, res, next) => {
  // Skip metrics collection for health checks and static files in production
  if (process.env.NODE_ENV === 'production') {
    if (req.path === '/health' || req.path === '/ready' || req.path.startsWith('/public/') || req.path.startsWith('/css/') || req.path.startsWith('/js/')) {
      return next();
    }
  }

  const start = process.hrtime.bigint(); // Use high-resolution timer

  res.on('finish', () => {
    try {
      const duration = Number(process.hrtime.bigint() - start) / 1e6; // Convert to milliseconds
      recordRequest(req.method, req.path, res.statusCode, duration);
    } catch (error) {
      // Silently fail metrics recording to avoid affecting response
      console.error('Metrics recording failed:', error.message);
    }
  });

  next();
};
