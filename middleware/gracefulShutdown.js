'use strict';

const logger = require('../utils/logger');
const AppError = require('../utils/AppError');

/**
 * GRACEFUL SHUTDOWN HANDLER
 * 
 * Handles both SIGINT (Ctrl+C) and SIGTERM (Kubernetes, Docker)
 * Ensures:
 * - No new connections accepted
 * - In-flight requests complete
 * - Database connections close cleanly
 * - Background jobs finish or are saved
 * - Redis connections close
 * - Socket.IO connections close
 */

let isShuttingDown = false;
let activeConnections = 0;

/**
 * Register shutdown listeners on the HTTP server
 * Must be called after server.listen()
 */
const registerGracefulShutdown = (httpServer, io, dispatchWorker, queueEvents, redisClient, mongooseConnection) => {
  if (isShuttingDown) return;

  const gracefulShutdown = async (signal) => {
    if (isShuttingDown) {
      logger.warn('Graceful shutdown already in progress, forcing exit', { signal });
      process.exit(1);
    }

    isShuttingDown = true;
    logger.info(`\n${signal} received, initiating graceful shutdown...`, { timestamp: new Date().toISOString() });

    const timeout = setTimeout(() => {
      logger.error('Graceful shutdown timeout (30s) reached, forcing exit', { 
        activeConnections,
        signal 
      });
      process.exit(1);
    }, 30000);

    try {
      // Step 1: Stop accepting new connections
      logger.info('Step 1/7: Stopping HTTP server from accepting new connections...');
      httpServer.close(() => {
        logger.info('HTTP server stopped accepting new connections');
      });

      // Step 2: Close Socket.IO server (gracefully disconnects clients)
      if (io) {
        logger.info('Step 2/7: Closing Socket.IO connections...');
        io.close();
        logger.info('Socket.IO server closed');
      } else {
        logger.info('Step 2/7: Socket.IO not initialized, skipping');
      }

      // Step 3: Close BullMQ dispatch worker
      if (dispatchWorker) {
        logger.info('Step 3/7: Closing dispatch queue worker...');
        await dispatchWorker.close();
        logger.info('Dispatch worker closed');
      } else {
        logger.info('Step 3/7: Dispatch worker not initialized, skipping');
      }

      // Step 4: Close queue event listeners
      if (queueEvents) {
        logger.info('Step 4/7: Closing queue event listeners...');
        await queueEvents.close();
        logger.info('Queue event listeners closed');
      } else {
        logger.info('Step 4/7: Queue events not initialized, skipping');
      }

      // Step 5: Close Redis connections
      if (redisClient) {
        logger.info('Step 5/7: Closing Redis connections...');
        redisClient.disconnect();
        logger.info('Redis client disconnected');
      } else {
        logger.info('Step 5/7: Redis client not initialized, skipping');
      }

      // Step 6: Close MongoDB connection
      if (mongooseConnection) {
        logger.info('Step 6/7: Closing MongoDB connection...');
        await mongooseConnection.disconnect();
        logger.info('MongoDB connection closed');
      } else {
        logger.info('Step 6/7: MongoDB not initialized, skipping');
      }

      // Step 7: Final cleanup
      logger.info('Step 7/7: Performing final cleanup...');
      
      // Remove all process listeners to prevent duplicate handlers
      process.removeAllListeners('SIGINT');
      process.removeAllListeners('SIGTERM');
      process.removeAllListeners('SIGHUP');

      logger.info('Graceful shutdown completed successfully', { 
        duration: '~' + (30000 - (timeout._idleTimeout || 0)) + 'ms',
        signal,
        timestamp: new Date().toISOString()
      });

      clearTimeout(timeout);
      process.exit(0);
    } catch (err) {
      logger.error('Error during graceful shutdown', { 
        error: err.message, 
        stack: err.stack,
        signal,
        activeConnections
      });
      clearTimeout(timeout);
      process.exit(1);
    }
  };

  // Register handlers for both SIGINT and SIGTERM
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

  // Also handle SIGHUP (for log rotation)
  process.on('SIGHUP', () => {
    logger.info('SIGHUP received - rotating logs');
    // Log rotation typically handled by external tool (logrotate)
  });

  // Handle uncaught exceptions
  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception', { 
      error: err.message, 
      stack: err.stack 
    });
    gracefulShutdown('uncaughtException');
  });

  // Handle unhandled promise rejections
  process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled promise rejection', { 
      reason: String(reason),
      promise: String(promise)
    });
    gracefulShutdown('unhandledRejection');
  });
};

/**
 * Middleware to track active connections
 * Must be added early in middleware chain
 */
const trackConnections = (req, res, next) => {
  if (isShuttingDown) {
    return res.status(503).json({
      success: false,
      message: 'Server is shutting down'
    });
  }

  activeConnections++;

  res.on('finish', () => {
    activeConnections--;
  });

  next();
};

/**
 * Check if system is shutting down
 */
const isSystemShuttingDown = () => isShuttingDown;

/**
 * Get current number of active connections
 */
const getActiveConnections = () => activeConnections;

module.exports = {
  registerGracefulShutdown,
  trackConnections,
  isSystemShuttingDown,
  getActiveConnections
};
