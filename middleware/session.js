'use strict';

const session = require('express-session');
const MongoStore = require('connect-mongo');

const maxAge = parseInt(process.env.SESSION_MAX_AGE, 10) || 7 * 24 * 60 * 60 * 1000;
const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  throw new Error('SESSION_SECRET is required for session security');
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
