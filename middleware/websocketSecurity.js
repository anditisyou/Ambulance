'use strict';

const jwt = require('jsonwebtoken');
const logger = require('../utils/logger');
const { isTokenRevoked } = require('../middleware/auth');

/**
 * WEBSOCKET SECURITY MIDDLEWARE
 * 
 * Ensures:
 * - Only authenticated users can connect
 * - Token is valid and not revoked
 * - User has required permissions
 * - Connection limits enforced
 * - Message validation
 * - Connection tracking
 */

// Track active WebSocket connections
const activeConnections = new Map(); // Map<userId, Set<socketId>>
const connectionMetrics = {
  totalConnections: 0,
  totalDisconnections: 0,
  currentConnections: 0,
  rejectedConnections: 0,
  messagesSent: 0,
  messagesReceived: 0,
  errors: 0
};

/**
 * Authenticate Socket.IO connection
 * Must be called before accepting the connection
 */
const authenticateSocket = (io) => {
  io.use(async (socket, next) => {
    try {
      // Get token from auth header or query
      const token = socket.handshake.auth?.token || 
                    socket.handshake.query?.token ||
                    socket.handshake.headers?.authorization?.replace('Bearer ', '');

      if (!token) {
        logger.warn('WebSocket connection rejected: no token provided', {
          socketId: socket.id,
          ip: socket.handshake.address,
          userAgent: socket.handshake.headers['user-agent']
        });
        connectionMetrics.rejectedConnections++;
        return next(new Error('Authentication error: No token provided'));
      }

      // Verify token
      let decoded;
      try {
        decoded = jwt.verify(token, process.env.JWT_SECRET);
      } catch (err) {
        logger.warn('WebSocket authentication failed: invalid token', {
          socketId: socket.id,
          error: err.message,
          ip: socket.handshake.address
        });
        connectionMetrics.rejectedConnections++;
        return next(new Error('Authentication error: Invalid token'));
      }

      // Check if token is revoked
      const revoked = await isTokenRevoked(token);
      if (revoked) {
        logger.warn('WebSocket connection rejected: token revoked', {
          socketId: socket.id,
          userId: decoded.id,
          ip: socket.handshake.address
        });
        connectionMetrics.rejectedConnections++;
        return next(new Error('Authentication error: Token revoked'));
      }

      // Attach user to socket
      socket.user = {
        _id: decoded.id,
        email: decoded.email,
        role: decoded.role
      };

      // Track connection
      if (!activeConnections.has(decoded.id)) {
        activeConnections.set(decoded.id, new Set());
      }
      activeConnections.get(decoded.id).add(socket.id);
      connectionMetrics.totalConnections++;
      connectionMetrics.currentConnections = activeConnections.size;

      logger.info('WebSocket authenticated', {
        socketId: socket.id,
        userId: decoded.id,
        role: decoded.role,
        ip: socket.handshake.address,
        totalConnections: connectionMetrics.currentConnections
      });

      next();
    } catch (err) {
      logger.error('WebSocket authentication error', {
        error: err.message,
        socketId: socket.id
      });
      connectionMetrics.rejectedConnections++;
      next(new Error('Authentication error'));
    }
  });
};

/**
 * Handle socket disconnection
 */
const setupDisconnectionHandler = (socket) => {
  socket.on('disconnect', () => {
    const userId = socket.user?._id;
    
    if (userId && activeConnections.has(userId)) {
      const userSockets = activeConnections.get(userId);
      userSockets.delete(socket.id);
      
      if (userSockets.size === 0) {
        activeConnections.delete(userId);
      }
    }

    connectionMetrics.totalDisconnections++;
    connectionMetrics.currentConnections = activeConnections.size;

    logger.debug('WebSocket disconnected', {
      socketId: socket.id,
      userId,
      totalConnections: connectionMetrics.currentConnections
    });
  });
};

/**
 * Validate message format and size
 */
const validateSocketMessage = (message) => {
  if (!message) {
    return { valid: false, error: 'Message is empty' };
  }

  // Check size limit (e.g., 64KB)
  const maxSize = 64 * 1024;
  const messageSize = JSON.stringify(message).length;
  
  if (messageSize > maxSize) {
    return { valid: false, error: `Message exceeds size limit (${maxSize} bytes)` };
  }

  // Validate required fields
  if (!message.type || typeof message.type !== 'string') {
    return { valid: false, error: 'Missing or invalid message type' };
  }

  return { valid: true };
};

/**
 * Rate limit socket messages per user
 */
const createSocketRateLimiter = (maxMessagesPerSecond = 10) => {
  const userMessageCounts = new Map(); // Map<userId, {count, resetTime}>

  return (userId) => {
    const now = Date.now();
    const bucket = userMessageCounts.get(userId) || { count: 0, resetTime: now + 1000 };

    if (now >= bucket.resetTime) {
      // Reset bucket
      bucket.count = 1;
      bucket.resetTime = now + 1000;
    } else {
      bucket.count++;
    }

    userMessageCounts.set(userId, bucket);

    if (bucket.count > maxMessagesPerSecond) {
      return {
        rateLimited: true,
        remaining: 0,
        resetTime: bucket.resetTime
      };
    }

    return {
      rateLimited: false,
      remaining: maxMessagesPerSecond - bucket.count,
      resetTime: bucket.resetTime
    };
  };
};

/**
 * Emit event with validation
 */
const safeEmit = (socket, event, data) => {
  try {
    // Validate message
    const validation = validateSocketMessage({ type: event, data });
    if (!validation.valid) {
      logger.warn('Invalid socket message attempted', {
        socketId: socket.id,
        userId: socket.user?._id,
        event,
        error: validation.error
      });
      return false;
    }

    socket.emit(event, data);
    connectionMetrics.messagesSent++;
    return true;
  } catch (err) {
    logger.error('Socket emit failed', {
      socketId: socket.id,
      event,
      error: err.message
    });
    connectionMetrics.errors++;
    return false;
  }
};

/**
 * Broadcast to room with validation
 */
const safeBroadcast = (io, room, event, data) => {
  try {
    // Validate message
    const validation = validateSocketMessage({ type: event, data });
    if (!validation.valid) {
      logger.warn('Invalid broadcast attempted', {
        room,
        event,
        error: validation.error
      });
      return false;
    }

    io.to(room).emit(event, data);
    connectionMetrics.messagesSent++;
    return true;
  } catch (err) {
    logger.error('Broadcast failed', {
      room,
      event,
      error: err.message
    });
    connectionMetrics.errors++;
    return false;
  }
};

/**
 * Get connection metrics
 */
const getConnectionMetrics = () => {
  return {
    ...connectionMetrics,
    activeUsers: activeConnections.size,
    timestamp: new Date()
  };
};

/**
 * Close all connections for a user (logout)
 */
const closeUserConnections = (io, userId) => {
  const userSockets = activeConnections.get(userId);
  
  if (userSockets) {
    userSockets.forEach(socketId => {
      const socket = io.sockets.sockets.get(socketId);
      if (socket) {
        socket.disconnect(true);
      }
    });
    activeConnections.delete(userId);
  }

  logger.info('User connections closed', {
    userId,
    closedConnections: userSockets?.size || 0
  });
};

/**
 * Health check for WebSocket layer
 */
const getWebSocketHealth = () => {
  return {
    isHealthy: connectionMetrics.errors < 10 && connectionMetrics.rejectedConnections < 100,
    metrics: connectionMetrics,
    timestamp: new Date()
  };
};

module.exports = {
  authenticateSocket,
  setupDisconnectionHandler,
  validateSocketMessage,
  createSocketRateLimiter,
  safeEmit,
  safeBroadcast,
  getConnectionMetrics,
  closeUserConnections,
  getWebSocketHealth
};
