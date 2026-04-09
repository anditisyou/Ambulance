require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const http = require('http');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const mongoSanitize = require('express-mongo-sanitize');
const sessionMiddleware = require('./middleware/session');
const requestId = require('./middleware/requestId');
const metricsMiddleware = require('./middleware/metrics');
const jwt = require('jsonwebtoken');
const Redis = require('ioredis');
const { createAdapter } = require('@socket.io/redis-adapter');
const User = require('./models/User');
const EmergencyRequest = require('./models/EmergencyRequest');
//const csrf = require('csurf');
const { Server } = require('socket.io');

// Add to index.js or server.js
const swaggerUi = require('swagger-ui-express');
const swaggerSpec = require('./config/swagger');

const { getPrometheusMetrics } = require('./utils/metrics');
const errorHandler = require('./middleware/errorHandler');
const logger = require('./utils/logger');

// Validate environment variables
const requiredEnvVars = ['JWT_SECRET', 'MONGODB_URI', 'SESSION_SECRET'];
if (process.env.NODE_ENV === 'production') {
  requiredEnvVars.push('REDIS_URL', 'FRONTEND_URL');
}
const missingEnvVars = requiredEnvVars.filter((v) => !process.env[v]);
if (missingEnvVars.length > 0) {
  logger.error(`FATAL: Missing environment variables: ${missingEnvVars.join(', ')}`);
  process.exit(1);
}

// Import routes
const authRoutes = require('./routes/authRoutes');
const medicalRoutes = require('./routes/medicalRoutes');
const emergencyRoutes = require('./routes/emergencyRoutes');
const ambulanceRoutes = require('./routes/ambulanceRoutes');
const dispatchRoutes = require('./routes/dispatchRoutes');
const requestStateRoutes = require('./routes/requestStateRoutes');
const driverRoutes = require('./routes/driverRoutes');
const hospitalTrackingRoutes = require('./routes/hospitalTrackingRoutes');
const monitoringRoutes = require('./routes/monitoringRoutes');
const analyticsRoutes = require('./routes/analyticsRoutes');
const adminRoutes = require('./routes/adminRoutes');
const hospitalRoutes = require('./routes/hospitalRoutes');
const constantsRoutes = require('./routes/constants');
const syncRoutes = require('./routes/syncRoutes');

// Import production safety utilities
const dataRetentionManager = require('./utils/dataRetentionManager');
const offlineDriverManager = require('./utils/offlineDriverManager');
const locationSmoother = require('./utils/locationSmoother');
const anomalyDetector = require('./utils/anomalyDetector');
const redisClient = require('./utils/redisClient');
const memoryMonitor = require('./utils/memoryMonitor');
const {
  dispatchWorker,
  queueEvents,
  dispatchQueueScheduler,
  dlqScheduler,
  startReconciliationLoop,
  stopReconciliationLoop,
  recoverDispatchState,
} = require('./utils/dispatchQueue');

const expressApp = express();
const server = http.createServer(expressApp);

const FRONTEND_URL = process.env.FRONTEND_URL || null;
const isDev = process.env.NODE_ENV !== 'production';

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (FRONTEND_URL) {
      return origin === FRONTEND_URL ? callback(null, true) : callback(new Error('CORS origin denied'));
    }
    if (isDev) return callback(null, true);
    return callback(new Error('CORS origin denied'));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
  credentials: true,
  preflightContinue: false,
};

// Socket.io setup
const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (FRONTEND_URL) {
        return origin === FRONTEND_URL ? callback(null, true) : callback(new Error('Not allowed by CORS'));
      }
      if (isDev) return callback(null, true);
      return callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
  }
});

if (process.env.REDIS_URL) {
  const pubClient = new Redis(process.env.REDIS_URL);
  const subClient = pubClient.duplicate();
  io.adapter(createAdapter(pubClient, subClient));
  pubClient.on('error', (err) => logger.warn('[Redis] Socket adapter error:', err.message));
  subClient.on('error', (err) => logger.warn('[Redis] Socket adapter error:', err.message));
}

expressApp.set('io', io);

// Security middleware
expressApp.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'",
                   "https://code.jquery.com",
                   "https://cdn.jsdelivr.net",
                   "https://cdn.tailwindcss.com",
                   "https://stackpath.bootstrapcdn.com",
                   "https://cdn.socket.io"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc:   ["'self'", "'unsafe-inline'",
                   "https://cdn.jsdelivr.net",
                   "https://cdn.tailwindcss.com",
                   "https://stackpath.bootstrapcdn.com",
                   "https://cdnjs.cloudflare.com",
                   "https://fonts.googleapis.com"],
      styleSrcAttr: ["'unsafe-inline'"],
      fontSrc:    ["'self'", "https:", "data:",
                   "https://fonts.gstatic.com",
                   "https://cdnjs.cloudflare.com"],
      connectSrc: ["'self'",
                   ...(FRONTEND_URL ? [FRONTEND_URL] : []),
                   "https://cdn.jsdelivr.net",
                   "https://stackpath.bootstrapcdn.com",
                   "https://cdn.socket.io"],
      imgSrc:     ["'self'", "data:", "https:"],
    }
  }
}));

// CORS configuration
expressApp.use(cors(corsOptions));

// Body parsers
expressApp.use(express.json({ limit: '10mb' }));
expressApp.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Security middleware
expressApp.use(cookieParser());
expressApp.use(sessionMiddleware);
expressApp.use(requestId);
expressApp.use(metricsMiddleware);
expressApp.use((req, res, next) => {
  logger.info(`[${req.requestId}] ${req.method} ${req.originalUrl}`);
  next();
});
expressApp.use(mongoSanitize());
/*
// CSRF protection (skip for API routes that use tokens)
const csrfProtection = csrf({ cookie: true });
expressApp.use('/api', (req, res, next) => {
  // Skip CSRF for authenticated API routes that use JWT
  if (req.headers.authorization || req.cookies.token) {
    return next();
  }
  csrfProtection(req, res, next);
});
*/
// Static files
expressApp.use(express.static(path.join(__dirname, 'public'), {
  maxAge: 0,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.js') || filePath.endsWith('.css') || filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store');
    }
  },
}));

// Advanced rate limiting with Redis backend
const rateLimiter = require('./utils/rateLimiter');

// Apply advanced rate limiting to all API routes
expressApp.use('/api', rateLimiter.middleware());

// Database connection with retry logic
let dispatchRecoveryInitialized = false;

const initializeDispatchRecovery = async () => {
  if (dispatchRecoveryInitialized) return;
  dispatchRecoveryInitialized = true;

  try {
    await recoverDispatchState();
    logger.info('Dispatch queue recovery complete');
  } catch (err) {
    logger.error('Dispatch queue recovery failed', { error: err.message });
  }

  try {
    startReconciliationLoop();
    logger.info('Dispatch reconciliation loop started');
  } catch (err) {
    logger.error('Failed to start dispatch reconciliation loop', { error: err.message });
  }
};

const connectWithRetry = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
      maxPoolSize: 100,          // Support 100 concurrent connections
      minPoolSize: 20,           // Keep 20 connections warm
      maxIdleTimeMS: 30000,      // Close idle connections after 30s
      retryWrites: true,         // Enable write retries for transactions
      retryReads: true,          // Auto-retry reads on transient failures
      waitQueueTimeoutMS: 10000, // Fail fast if no connections available
      bufferMaxEntries: 0,       // Disable mongoose buffering
      bufferCommands: false,     // Disable mongoose buffering
    });
    logger.info('MongoDB connected successfully');
    await initializeDispatchRecovery();
  } catch (err) {
    logger.error('MongoDB connection error:', err);
    logger.info('Retrying connection in 5 seconds...');
    setTimeout(connectWithRetry, 5000);
  }
};

connectWithRetry();

// Routes
expressApp.use('/api/auth', authRoutes);
expressApp.use('/api/medical', medicalRoutes);
expressApp.use('/api/emergency', emergencyRoutes);
expressApp.use('/api/ambulances', ambulanceRoutes);
expressApp.use('/api/dispatch', dispatchRoutes);
expressApp.use('/api/request-state', requestStateRoutes);
expressApp.use('/api/driver', driverRoutes);
expressApp.use('/api/hospital-tracking', hospitalTrackingRoutes);
expressApp.use('/api/monitoring', monitoringRoutes);
expressApp.use('/api/sync', syncRoutes);
expressApp.use('/api/hospitals', hospitalRoutes);
expressApp.use('/api/analytics', analyticsRoutes);
expressApp.use('/api/admin', adminRoutes);
expressApp.use('/api/constants', constantsRoutes);

// Metrics endpoint
expressApp.get('/metrics', (req, res) => {
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.send(getPrometheusMetrics());
});

// Frontend routes
expressApp.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

expressApp.get('/user-dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'user-dashboard.html'));
});

expressApp.get('/hospital-dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'hospital-dashboard.html'));
});

expressApp.get('/ambulance-dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'ambulance-dashboard.html'));
});

expressApp.get('/metrics-dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'metrics-dashboard.html'));
});

// Swagger docs
expressApp.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
  explorer: true,
  customCss: '.swagger-ui .topbar { display: none }',
  customSiteTitle: 'ERS API Documentation',
}));

expressApp.get('/api-docs.json', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.send(swaggerSpec);
});

// Health check endpoint with detailed system status
expressApp.get('/health', async (req, res) => {
  try {
    const health = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      version: process.env.npm_package_version || '1.0.0',
      environment: process.env.NODE_ENV || 'development',
      checks: {}
    };

    // Database health check
    try {
      await mongoose.connection.db.admin().ping();
      health.checks.database = { status: 'healthy', responseTime: Date.now() };
    } catch (error) {
      health.checks.database = { status: 'unhealthy', error: error.message };
      health.status = 'degraded';
    }

    // Redis health check
    if (redisClient) {
      try {
        await redisClient.ping();
        health.checks.redis = { status: 'healthy', responseTime: Date.now() };
      } catch (error) {
        health.checks.redis = { status: 'unhealthy', error: error.message };
        health.status = 'degraded';
      }
    }

    // Memory usage
    const memUsage = process.memoryUsage();
    const memoryStats = memoryMonitor.getStats();
    health.checks.memory = {
      status: memUsage.heapUsed / memUsage.heapTotal > 0.9 ? 'warning' : 'healthy',
      used: memoryStats.heapUsed,
      total: memoryStats.heapTotal,
      external: memoryStats.external,
      rss: memoryStats.rss,
      lastGC: memoryStats.lastGC,
    };

    // Load average (if available)
    if (typeof process.cpuUsage === 'function') {
      const cpuUsage = process.cpuUsage();
      health.checks.cpu = {
        status: 'healthy',
        user: cpuUsage.user,
        system: cpuUsage.system
      };
    }

    // Queue health
    const queueStats = await redisClient.keys('bull:*:waiting');
    health.checks.queue = {
      status: 'healthy',
      waitingJobs: queueStats.length
    };

    // Response time based health
    const avgResponseTime = metrics.getMetrics().avgResponseTime;
    health.checks.performance = {
      status: avgResponseTime > 5000 ? 'warning' : 'healthy',
      avgResponseTime: Math.round(avgResponseTime)
    };

    const statusCode = health.status === 'healthy' ? 200 :
                      health.status === 'degraded' ? 200 : 503; // degraded still returns 200 for load balancers

    res.status(statusCode).json(health);
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: error.message
    });
  }
});

// 404 handler
expressApp.use('*', (req, res) => {
  res.status(404).json({ success: false, message: 'Route not found' });
});

// Error handling middleware
expressApp.use(errorHandler);

// Socket.io connection handling
const { ROLES } = require('./utils/constants');

io.use(async (socket, next) => {
  try {
    const tokenFromAuth = socket.handshake.auth?.token;
    const tokenFromHeader = (socket.handshake.headers?.authorization || '').startsWith('Bearer ')
      ? socket.handshake.headers.authorization.slice(7)
      : null;
    const tokenFromCookie = (() => {
      const cookieHeader = socket.handshake.headers?.cookie;
      if (!cookieHeader) return null;
      return cookieHeader.split(';').reduce((acc, pair) => {
        const [key, ...rest] = pair.split('=');
        if (!key || rest.length === 0) return acc;
        acc[key.trim()] = decodeURIComponent(rest.join('=').trim());
        return acc;
      }, {})?.token || null;
    })();

    const token = tokenFromAuth || tokenFromHeader || tokenFromCookie;

    if (!token) {
      return next(new Error('Authentication error'));
    }

    if (await isTokenRevoked(token)) {
      return next(new Error('Authentication error'));
    }

    if (!process.env.JWT_SECRET) {
      return next(new Error('Server configuration error'));
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded?.id) {
      return next(new Error('Authentication error'));
    }

    const user = await User.findById(decoded.id).select('role isActive');
    if (!user || !user.isActive) {
      return next(new Error('Authentication error'));
    }

    socket.user = { id: String(user._id), role: user.role };
    next();
  } catch (err) {
    logger.warn('Socket authentication failed', err.message);
    next(new Error('Authentication error'));
  }
});

io.on('connection', (socket) => {
  const { user } = socket;
  logger.info(`New socket connected: ${socket.id} user=${user?.id}`);

  // Rate limiting for join attempts
  const joinAttempts = new Map();

  socket.join(`user_${user.id}`);
  if (user.role === ROLES.DRIVER) socket.join(`driver_${user.id}`);
  if (user.role === ROLES.ADMIN) socket.join('admins');
  if (user.role === ROLES.DISPATCHER) socket.join('dispatchers');
  if (user.role === ROLES.HOSPITAL) socket.join(`hospital_${user.id}`);

  socket.on('join', async (data) => {
    if (!data?.requestId) return;

    // Rate limiting: max 10 joins per socket
    const attempts = joinAttempts.get(socket.id) || 0;
    if (attempts >= 10) {
      socket.emit('joinError', { message: 'Too many join attempts' });
      socket.disconnect();
      return;
    }
    joinAttempts.set(socket.id, attempts + 1);

    // Validate requestId format
    if (!mongoose.Types.ObjectId.isValid(data.requestId)) {
      socket.emit('joinError', { message: 'Invalid request ID' });
      return;
    }

    try {
      const request = await EmergencyRequest.findById(data.requestId)
        .populate({ path: 'assignedAmbulanceId', select: 'driverId' })
        .lean();

      if (!request) {
        socket.emit('joinError', { message: 'Request not found' });
        return;
      }

      const isRequestMember =
        user.role === ROLES.ADMIN ||
        user.role === ROLES.DISPATCHER ||
        String(request.userId) === user.id ||
        String(request.assignedHospital) === user.id ||
        String(request.assignedAmbulanceId?.driverId) === user.id;

      if (!isRequestMember) {
        socket.emit('joinError', { message: 'Not authorised to join this request room' });
        return;
      }

      socket.join(`request_${request._id}`);
    } catch (err) {
      logger.warn('Socket join request room failed', err.message);
      socket.emit('joinError', { message: 'Unable to join request room' });
    }
  });

  socket.on('disconnect', () => {
    logger.info(`Socket disconnected: ${socket.id}`);
  });
});

// Redis subscriber for cross-process socket events
const subscriber = new Redis(process.env.REDIS_URL);
subscriber.subscribe('socket-events', (err) => {
  if (err) logger.error('Failed to subscribe to socket-events', err);
  else logger.info('Subscribed to socket-events channel');
});

subscriber.subscribe('socket-events-batch', (err) => {
  if (err) logger.error('Failed to subscribe to socket-events-batch', err);
  else logger.info('Subscribed to socket-events-batch channel');
});

subscriber.on('message', (channel, message) => {
  try {
    if (channel === 'socket-events') {
      const { room, event, data } = JSON.parse(message);
      io.to(room).emit(event, data);
      logger.debug('Emitted socket event from Redis', { room, event });
    } else if (channel === 'socket-events-batch') {
      const batch = JSON.parse(message);
      // Process batched events
      for (const eventData of batch) {
        const { room, event, data } = eventData;
        io.to(room).emit(event, data);
      }
      logger.debug('Emitted batched socket events from Redis', { count: batch.length });
    }
  } catch (error) {
    logger.error('Failed to parse socket event message', { error: error.message, channel });
  }
});

// Graceful shutdown
const gracefulShutdown = async (signal) => {
  logger.info(`\n${signal} received, shutting down gracefully...`);
  
  try {
    // 1. Stop accepting new connections
    if (server) {
      server.close(() => {
        logger.info('HTTP server closed');
      });
    }

    // 2. Stop background reconciliation
    if (stopReconciliationLoop) {
      await stopReconciliationLoop();
      logger.info('Dispatch reconciliation loop stopped');
    }

    // 3. Close all socket connections
    if (io) {
      io.close();
      logger.info('Socket.IO closed');
    }

    // 4. Gracefully close dispatch workers and queue infrastructure
    if (dispatchWorker) {
      await dispatchWorker.close();
      logger.info('Dispatch worker closed');
    }
    if (queueEvents) {
      await queueEvents.close();
      logger.info('Queue events closed');
    }
    if (dispatchQueueScheduler) {
      await dispatchQueueScheduler.close();
      logger.info('Dispatch queue scheduler closed');
    }
    if (dlqScheduler) {
      await dlqScheduler.close();
      logger.info('Dead-letter queue scheduler closed');
    }

    // 5. Close Redis connections
    if (subscriber) {
      subscriber.disconnect();
      logger.info('Redis subscriber closed');
    }
    if (redisClient) {
      redisClient.disconnect();
      logger.info('Redis client closed');
    }

    // 6. Cleanup background jobs
    if (dataRetentionManager && dataRetentionManager.cleanup) {
      dataRetentionManager.cleanup();
      logger.info('Data retention jobs cleaned');
    }
    if (offlineDriverManager && offlineDriverManager.cleanup) {
      offlineDriverManager.cleanup();
      logger.info('Offline driver manager cleaned');
    }
    // 8. Stop memory monitoring
    if (memoryMonitor && memoryMonitor.stop) {
      memoryMonitor.stop();
      logger.info('Memory monitoring stopped');
    }
    // 7. Close database connection
    await mongoose.disconnect();
    logger.info('MongoDB connection closed');

    // 8. Exit cleanly
    process.exit(0);
  } catch (err) {
    logger.error(`Shutdown error: ${err.message}`);
    process.exit(1);
  }
};

// Handle both SIGINT (Ctrl+C) and SIGTERM (Kubernetes)
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Handle uncaught exceptions (final safety net)
process.on('uncaughtException', (err) => {
  logger.error('⚠️ Uncaught exception:', err);
  gracefulShutdown('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason) => {
  logger.error('⚠️ Unhandled promise rejection:', reason);
  gracefulShutdown('UNHANDLED_REJECTION');
});

// Start server
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  const httpServer = server.listen(PORT, () => {
    logger.info(`Server running on port ${PORT}`);
  });

  // Initialize production safety systems
  try {
    if (dataRetentionManager && dataRetentionManager.initialize) {
      dataRetentionManager.initialize();
      logger.info('✅ Data retention cleanup jobs initialized');
    }
  } catch (err) {
    logger.error(`⚠️ Data retention init failed: ${err.message}`);
  }

  // Start memory monitoring
  try {
    memoryMonitor.start();
    logger.info('✅ Memory monitoring started');
  } catch (err) {
    logger.error(`⚠️ Memory monitoring init failed: ${err.message}`);
  }

  // Global reference to io for offline driver manager
  if (offlineDriverManager && offlineDriverManager.setIO) {
    offlineDriverManager.setIO(io);
  }
}

module.exports = { expressApp, server };