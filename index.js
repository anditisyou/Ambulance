'use strict';

/**
 * Emergency Response System — Server entry point.
 *
 * Replaces the original index.js which was a Cloudinary sample script
 * with no Express server, no DB connection, and hardcoded credentials.
 */

require('dotenv').config();

const http      = require('http');
const express   = require('express');
const mongoose  = require('mongoose');
const cookieParser = require('cookie-parser');
const helmet    = require('helmet');
const cors      = require('cors');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');

// ─── Route imports ────────────────────────────────────────────────────────────
const authRoutes      = require('./routes/authRoutes');
const emergencyRoutes = require('./routes/emergencyRoutes');
const dispatchRoutes  = require('./routes/dispatchRoutes');
const ambulanceRoutes = require('./routes/ambulanceRoutes');
const adminRoutes     = require('./routes/adminRoutes');
const analyticsRoutes = require('./routes/analyticsRoutes');
const medicalRoutes   = require('./routes/medicalRoutes');

// ─── Env validation ───────────────────────────────────────────────────────────
const REQUIRED_ENV = ['MONGODB_URI', 'JWT_SECRET'];
const missingEnv   = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missingEnv.length) {
  console.error(`[Server] Missing required environment variables: ${missingEnv.join(', ')}`);
  process.exit(1);
}

// ─── App setup ────────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

// ─── Security headers ─────────────────────────────────────────────────────────
app.use(helmet());

// ─── CORS ─────────────────────────────────────────────────────────────────────
app.use(cors({
  origin:      process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
}));

// ─── Body parsing ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

// ─── Global rate limiting ─────────────────────────────────────────────────────
app.use('/api/', rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max:      200,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { success: false, message: 'Too many requests — please try again later' },
}));

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/api/auth',       authRoutes);
app.use('/api/emergency',  emergencyRoutes);
app.use('/api/dispatch',   dispatchRoutes);
app.use('/api/ambulances', ambulanceRoutes);
app.use('/api/admin',      adminRoutes);
app.use('/api/analytics',  analyticsRoutes);
app.use('/api/medical',    medicalRoutes);

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) =>
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() })
);

// ─── 404 handler ──────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ success: false, message: 'Route not found' });
});

// ─── Global error handler ─────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  const statusCode = err.statusCode || 500;
  const message    = err.isOperational ? err.message : 'Internal server error';

  if (!err.isOperational) {
    console.error('[Unhandled Error]', err);
  }

  res.status(statusCode).json({
    success: false,
    status:  err.status || 'error',
    message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
});

// ─── Socket.IO ────────────────────────────────────────────────────────────────
const io = new Server(server, {
  cors: {
    origin:      process.env.FRONTEND_URL || 'http://localhost:3000',
    credentials: true,
  },
});

// Attach io to app so controllers can access it via req.app.get('io')
app.set('io', io);

io.on('connection', (socket) => {
  // Client sends { userId, role } on connect to join their personal room
  socket.on('join', ({ userId, role }) => {
    if (userId) socket.join(`user_${userId}`);
    if (role === 'ADMIN' || role === 'DISPATCHER') socket.join('admins');
    if (role === 'DRIVER' && userId)  socket.join(`driver_${userId}`);
  });

  socket.on('joinRequest', ({ requestId }) => {
    if (requestId) socket.join(`request_${requestId}`);
  });

  socket.on('joinAmbulance', ({ ambulanceId }) => {
    if (ambulanceId) socket.join(`ambulance_${ambulanceId}`);
  });

  socket.on('disconnect', () => {
    // socket.io automatically handles room cleanup
  });
});

// ─── MongoDB connection + server start ────────────────────────────────────────
const PORT = parseInt(process.env.PORT, 10) || 3000;

mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => {
    console.info('[MongoDB] Connected successfully');
    server.listen(PORT, () => {
      console.info(`[Server] Listening on port ${PORT} (${process.env.NODE_ENV || 'development'})`);
    });
  })
  .catch((err) => {
    console.error('[MongoDB] Connection failed:', err.message);
    process.exit(1);
  });

// ─── Graceful shutdown ────────────────────────────────────────────────────────
const shutdown = async (signal) => {
  console.info(`[Server] ${signal} received — shutting down gracefully`);
  server.close(async () => {
    await mongoose.connection.close();
    console.info('[Server] Closed');
    process.exit(0);
  });
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// Surface unhandled rejections (don't let them go silent)
process.on('unhandledRejection', (reason) => {
  console.error('[UnhandledRejection]', reason);
  process.exit(1);
});

module.exports = { app, server }; // exported for testing
