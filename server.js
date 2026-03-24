const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const http = require('http');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const mongoSanitize = require('express-mongo-sanitize');
//const csrf = require('csurf');
const { Server } = require('socket.io');
require('dotenv').config();

const logger = require('./utils/logger');
const errorHandler = require('./middleware/errorHandler');

// Validate environment variables
//const requiredEnvVars = ['JWT_SECRET', 'MONGODB_URI', 'CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'];
const requiredEnvVars = ['JWT_SECRET', 'MONGODB_URI'];
const missingEnvVars = requiredEnvVars.filter(v => !process.env[v]);
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
const analyticsRoutes = require('./routes/analyticsRoutes');
const adminRoutes = require('./routes/adminRoutes');
const constantsRoutes = require('./routes/constants');

const expressApp = express();
const server = http.createServer(expressApp);

// Socket.io setup
const io = new Server(server, {
  cors: { 
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    credentials: true 
  }
});

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
                   "https://stackpath.bootstrapcdn.com"],
      styleSrc:   ["'self'", "'unsafe-inline'",
                   "https://cdn.jsdelivr.net",
                   "https://cdn.tailwindcss.com",
                   "https://stackpath.bootstrapcdn.com",
                   "https://cdnjs.cloudflare.com",
                   "https://fonts.googleapis.com"],
      fontSrc:    ["'self'", "https:", "data:",
                   "https://fonts.gstatic.com",
                   "https://cdnjs.cloudflare.com"],
      connectSrc: ["'self'",
                   process.env.FRONTEND_URL || "http://localhost:3000",
                   "https://cdn.jsdelivr.net"],
      imgSrc:     ["'self'", "data:", "https:"],
    }
  }
}));

// CORS configuration
expressApp.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true
}));

// Body parsers
expressApp.use(express.json({ limit: '10mb' }));
expressApp.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Security middleware
expressApp.use(mongoSanitize());
expressApp.use(cookieParser());
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
expressApp.use(express.static(path.join(__dirname, 'public')));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { success: false, message: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false
});
expressApp.use('/api', limiter);

const authLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  message: { success: false, message: 'Too many attempts, please try again later' }
});
expressApp.use('/api/login', authLimiter);
expressApp.use('/api/register', authLimiter);

const sensitiveLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { success: false, message: 'Too many requests, please try again later' }
});
expressApp.use('/api/forgot-password', sensitiveLimiter);
expressApp.use('/api/reset-password', sensitiveLimiter);

// Database connection with retry logic
const connectWithRetry = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      //useNewUrlParser: true,
      //useUnifiedTopology: true,
      serverSelectionTimeoutMS: 5000
    });
    logger.info('MongoDB connected successfully');
  } catch (err) {
    logger.error('MongoDB connection error:', err);
    logger.info('Retrying connection in 5 seconds...');
    setTimeout(connectWithRetry, 5000);
  }
};

connectWithRetry();

// Routes
expressApp.use('/api', authRoutes);
expressApp.use('/api/medical', medicalRoutes);
expressApp.use('/api/emergency', emergencyRoutes);
expressApp.use('/api/ambulances', ambulanceRoutes);
expressApp.use('/api/dispatch', dispatchRoutes);
expressApp.use('/api/analytics', analyticsRoutes);
expressApp.use('/api/admin', adminRoutes);
expressApp.use('/api/constants', constantsRoutes);

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

expressApp.get('/admin-dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-dashboard.html'));
});

// 404 handler
expressApp.use('*', (req, res) => {
  res.status(404).json({ success: false, message: 'Route not found' });
});

// Error handling middleware
expressApp.use(errorHandler);

// Socket.io connection handling
const { ROLES } = require('./utils/constants');
io.on('connection', (socket) => {
  logger.info(`New socket connected: ${socket.id}`);

  socket.on('join', (data) => {
    if (data.userId) socket.join(`user_${data.userId}`);
    if (data.requestId) socket.join(`request_${data.requestId}`);
    if (data.role === ROLES.ADMIN) {
      socket.join('admins');
    }
  });

  socket.on('disconnect', () => {
    logger.info(`Socket disconnected: ${socket.id}`);
  });
});

// Start server
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    logger.info(`Server running on port ${PORT}`);
  });
}

module.exports = { expressApp, server };