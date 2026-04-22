'use strict';

const { v4: uuidv4 } = require('uuid');

module.exports = (req, res, next) => {
  const requestId = req.get('X-Request-Id') || uuidv4();

  req.requestId = requestId;
  res.locals.requestId = requestId;
  res.set('X-Request-Id', requestId);

  const originalJson = res.json.bind(res);
  res.json = (body) => {
    if (body && typeof body === 'object' && !Array.isArray(body) && body.requestId === undefined) {
      body.requestId = requestId;
    }
    return originalJson(body);
  };

  next();
};
