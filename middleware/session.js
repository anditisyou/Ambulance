'use strict';

const session = require('express-session');
const MongoStore = require('connect-mongo');
const crypto = require('crypto');

const maxAge = parseInt(process.env.SESSION_MAX_AGE, 10) || 7 * 24 * 60 * 60 * 1000;
let sessionSecret = process.env.SESSION_SECRET;

// Production should fail fast with a clear message; development can use a temporary secret.
if (!sessionSecret) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('SESSION_SECRET is required in production. Set SESSION_SECRET in environment variables.');
  }
  sessionSecret = crypto.randomBytes(32).toString('hex');
  // eslint-disable-next-line no-console
  console.warn('[Session] SESSION_SECRET missing in non-production; using ephemeral in-memory fallback.');
}

module.exports = session({
  name: process.env.SESSION_NAME || 'ers_session',
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({
    mongoUrl: process.env.MONGODB_URI,
    ttl: Math.floor(maxAge / 1000),
    autoRemove: 'interval',
    autoRemoveInterval: 10,
  }),
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge,
  },
});
