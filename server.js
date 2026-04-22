// jai jaaganath O!O
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

const { getPrometheusMetrics, getMetrics } = require('./utils/metrics');
const errorHandler = require('./middleware/errorHandler');
const logger = require('./utils/logger');

let isTokenRevoked = async () => false;
try {
  const authModule = require('./middleware/auth');
  if (typeof authModule.isTokenRevoked === 'function') {
    isTokenRevoked = authModule.isTokenRevoked;
  } else {
    logger.warn('Socket token revocation checker not exported; continuing without revocation checks');
  }
} catch (err) {
  logger.warn('Token revocation checker unavailable for sockets; continuing without revocation checks', {
    error: err.message,
  });
}

const buildRedisConnection = () => {
  if (process.env.REDIS_URL) {
    try {
      const parsed = new URL(process.env.REDIS_URL);
      return {
        host: parsed.hostname,
        port: Number(parsed.port || 6379),
        username: parsed.username || undefined,
        password: parsed.password || undefined,
        tls: parsed.protocol === 'rediss:' ? {} : undefined,
      };
    } catch (err) {
      logger.warn('Invalid REDIS_URL; falling back to REDIS_HOST/REDIS_PORT', { error: err.message });
    }
  }

  return {
    host: process.env.REDIS_HOST || 'localhost',
    port: Number(process.env.REDIS_PORT || 6379),
    password: process.env.REDIS_PASSWORD || undefined,
  };
};

const redisConnection = buildRedisConnection();

// Validate environment variables
const requiredEnvVars = ['JWT_SECRET', 'MONGODB_URI', 'SESSION_SECRET'];
if (process.env.NODE_ENV === 'production') {
  requiredEnvVars.push('FRONTEND_URL');
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

const normalizeOrigin = (url) => {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}`;
  } catch (_) {
    return url.replace(/\/+$/, '');
  }
};

const frontendOrigin = normalizeOrigin(FRONTEND_URL);

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (frontendOrigin) {
      const requestOrigin = normalizeOrigin(origin);
      if (requestOrigin === frontendOrigin) return callback(null, true);
      logger.warn('CORS origin denied', { origin, requestOrigin, frontendOrigin });
      return callback(new Error('CORS origin denied'));
    }
    if (isDev) return callback(null, true);
    logger.warn('CORS origin denied', { origin, frontendOrigin });
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
      if (frontendOrigin) {
        const requestOrigin = normalizeOrigin(origin);
        if (requestOrigin === frontendOrigin) return callback(null, true);
        logger.warn('Socket CORS origin denied', { origin, requestOrigin, frontendOrigin });
        return callback(new Error('Not allowed by CORS'));
      }
      if (isDev) return callback(null, true);
      logger.warn('Socket CORS origin denied', { origin, frontendOrigin });
      return callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
  },
  transports: ['polling', 'websocket'],
  allowEIO3: true,
});

if (process.env.REDIS_URL || process.env.REDIS_HOST || process.env.REDIS_PORT) {
  const adapterOptions = {
    connectTimeout: 10000,
    enableOfflineQueue: true, // Enable offline queue to prevent "Stream isn't writeable" errors
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => Math.min(times * 50, 2000),
    reconnectOnError: (err) => {
      if (err.message.includes('ETIMEDOUT') || err.message.includes('ECONNRESET')) {
        return true;
      }
      return false;
    },
    autoResubscribe: true,
  };

  const pubClient = new Redis(redisConnection, adapterOptions);
  const subClient = pubClient.duplicate();

  // Track readiness state
  let pubReady = false;
  let subReady = false;

  const checkAndInitializeAdapter = () => {
    if (pubReady && subReady) {
      console.log('[Redis] Adapter initializing...');
      io.adapter(createAdapter(pubClient, subClient));
      logger.info('[Redis] Socket.IO Redis adapter initialized successfully');
    }
  };

  const adapterRedisLogger = (clientName, err) => logger.warn(`[Redis] Socket adapter ${clientName} error:`, err.message || err);
  pubClient.on('error', (err) => adapterRedisLogger('publisher', err));
  subClient.on('error', (err) => adapterRedisLogger('subscriber', err));
  pubClient.on('connect', () => logger.info('[Redis] Socket adapter publisher connected'));
  subClient.on('connect', () => logger.info('[Redis] Socket adapter subscriber connected'));
  pubClient.on('ready', () => {
    logger.info('[Redis] Socket adapter publisher ready');
    pubReady = true;
    checkAndInitializeAdapter();
  });
  subClient.on('ready', () => {
    logger.info('[Redis] Socket adapter subscriber ready');
    subReady = true;
    checkAndInitializeAdapter();
  });
  pubClient.on('close', () => logger.warn('[Redis] Socket adapter publisher closed'));
  subClient.on('close', () => logger.warn('[Redis] Socket adapter subscriber closed'));
  pubClient.on('reconnecting', (delay) => logger.warn('[Redis] Socket adapter publisher reconnecting in', delay, 'ms'));
  subClient.on('reconnecting', (delay) => logger.warn('[Redis] Socket adapter subscriber reconnecting in', delay, 'ms'));
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
let mongoReadyResolved = false;
let resolveMongoReady;

const waitForMongoConnection = new Promise((resolve) => {
  resolveMongoReady = resolve;
});

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
    });
    logger.info('MongoDB connected successfully');
    await initializeDispatchRecovery();
    if (!mongoReadyResolved) {
      mongoReadyResolved = true;
      resolveMongoReady();
    }
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
  const health = {
    // Keep stable "ok" for orchestrator checks while exposing detailed state separately.
    status: 'ok',
    state: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: process.env.npm_package_version || '1.0.0',
    environment: process.env.NODE_ENV || 'development',
    checks: {},
  };

  try {
    if (mongoose.connection?.db?.admin) {
      await mongoose.connection.db.admin().ping();
      health.checks.database = { status: 'healthy' };
    } else {
      health.checks.database = { status: 'unhealthy', error: 'MongoDB connection not initialized' };
      health.state = 'degraded';
    }
  } catch (error) {
    health.checks.database = { status: 'unhealthy', error: error.message };
    health.state = 'degraded';
  }

  try {
    if (redisClient && typeof redisClient.ping === 'function') {
      await redisClient.ping();
      health.checks.redis = { status: 'healthy' };
    } else {
      health.checks.redis = { status: 'unavailable', error: 'Redis client not configured' };
    }
  } catch (error) {
    health.checks.redis = { status: 'unhealthy', error: error.message };
    health.state = 'degraded';
  }

  try {
    const memoryStats = memoryMonitor.getStats();
    const memUsage = process.memoryUsage();
    health.checks.memory = {
      status: memUsage.heapUsed / memUsage.heapTotal > 0.9 ? 'warning' : 'healthy',
      used: memoryStats.heapUsed,
      total: memoryStats.heapTotal,
      external: memoryStats.external,
      rss: memoryStats.rss,
      lastGC: memoryStats.lastGC,
    };
  } catch (error) {
    health.checks.memory = { status: 'unavailable', error: error.message };
  }

  try {
    const runtimeMetrics = getMetrics();
    const avgResponseTime = runtimeMetrics?.avgResponseTime || 0;
    health.checks.performance = {
      status: avgResponseTime > 5000 ? 'warning' : 'healthy',
      avgResponseTime: Math.round(avgResponseTime),
    };
  } catch (error) {
    health.checks.performance = { status: 'unavailable', error: error.message };
  }

  return res.status(200).json(health);
});

// Readiness probe: strict dependency check for orchestrators.
expressApp.get('/ready', async (req, res) => {
  const readiness = {
    status: 'ready',
    timestamp: new Date().toISOString(),
    checks: {
      database: 'unknown',
      redis: 'unknown',
    },
  };

  let hasFailure = false;

  try {
    if (mongoose.connection?.readyState !== 1) {
      throw new Error(`MongoDB not connected (readyState=${mongoose.connection?.readyState})`);
    }
    await mongoose.connection.db.admin().ping();
    readiness.checks.database = 'ok';
  } catch (err) {
    readiness.checks.database = `failed: ${err.message}`;
    hasFailure = true;
  }

  try {
    if (redisClient && typeof redisClient.ping === 'function') {
      await redisClient.ping();
      readiness.checks.redis = 'ok';
    } else {
      readiness.checks.redis = 'skipped';
    }
  } catch (err) {
    readiness.checks.redis = `failed: ${err.message}`;
    hasFailure = true;
  }

  if (hasFailure) {
    readiness.status = 'not_ready';
    return res.status(503).json(readiness);
  }

  return res.status(200).json(readiness);
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

// Log Socket.IO engine connection errors for diagnostics
io.engine.on('connection_error', (err) => {
  logger.warn('[Socket.IO] Engine connection error:', err.message || err);
});

// Redis subscriber for cross-process socket events.
let subscriber = null;
subscriber = new Redis(redisConnection);

const initializeSocketSubscriber = () => {
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
};

subscriber.on('connect', () => logger.info('[Socket subscriber] connected'));
subscriber.on('ready', () => logger.info('[Socket subscriber] ready'));
subscriber.on('error', (err) => logger.error('[Socket subscriber] error', err));
subscriber.on('close', () => logger.warn('[Socket subscriber] closed'));

initializeSocketSubscriber();

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

    // 8. Exit cleanly (only in production)
    const isProd = process.env.NODE_ENV === 'production';
    if (isProd) {
      process.exit(0);
    } else {
      console.warn('⚠️ Skipping process.exit() in development mode');
    }
  } catch (err) {
    logger.error(`Shutdown error: ${err.message}`);
    const isProd = process.env.NODE_ENV === 'production';
    if (isProd) {
      process.exit(1);
    } else {
      console.error('⚠️ Shutdown error in development mode:', err);
    }
  }
};

// Handle both SIGINT (Ctrl+C) and SIGTERM (Kubernetes)
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Handle uncaught exceptions (final safety net)
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err.message);
  console.error(err?.stack);
  gracefulShutdown('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason);
  console.error(reason?.stack);
  gracefulShutdown('UNHANDLED_REJECTION');
});

// Start server
if (require.main === module) {
  const startApp = async () => {
    await waitForMongoConnection;
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
  };

  startApp().catch((err) => {
    logger.error('Failed to start server:', err);
  });
}

module.exports = { expressApp, server, waitForMongoConnection };
