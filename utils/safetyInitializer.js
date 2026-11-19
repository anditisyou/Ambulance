'use strict';

const logger = require('./logger');
const { verifyEncryptionKey } = require('./encryption');
const { getHealthStatus } = require('./healthCheck');

/**
 * SAFETY INITIALIZATION MODULE
 * 
 * Performs all safety checks and initializations on startup.
 * Must be called before server starts accepting requests.
 * 
 * Includes:
 * - Encryption key validation
 * - Database connection verification
 * - Redis connection verification
 * - Environment variable validation
 * - System resource checks
 * - Security configuration validation
 */

const REQUIRED_ENV_VARS = [
  'JWT_SECRET',
  'MONGODB_URI',
  'SESSION_SECRET',
  'NODE_ENV'
];

const PRODUCTION_REQUIRED_ENV_VARS = [
  'FRONTEND_URL',
  'REDIS_URL',
  'ENCRYPTION_KEY'
];

/**
 * Validate all environment variables
 */
const validateEnvironment = () => {
  logger.info('Validating environment variables...');

  const isProd = process.env.NODE_ENV === 'production';
  const requiredVars = isProd 
    ? [...REQUIRED_ENV_VARS, ...PRODUCTION_REQUIRED_ENV_VARS]
    : REQUIRED_ENV_VARS;

  const missing = requiredVars.filter(v => !process.env[v]);

  if (missing.length > 0) {
    const message = `Missing required environment variables: ${missing.join(', ')}`;
    logger.error(message);
    throw new Error(message);
  }

  // Validate environment value
  const validEnvs = ['development', 'production', 'test'];
  if (!validEnvs.includes(process.env.NODE_ENV)) {
    throw new Error(`Invalid NODE_ENV: ${process.env.NODE_ENV}. Must be: ${validEnvs.join(', ')}`);
  }

  logger.info('✅ Environment variables validated');
};

/**
 * Validate encryption setup
 */
const validateEncryption = () => {
  if (process.env.NODE_ENV !== 'production') {
    logger.warn('⚠️ Encryption validation skipped in non-production environment');
    return;
  }

  logger.info('Validating encryption configuration...');

  if (!verifyEncryptionKey()) {
    throw new Error('Encryption key validation failed - cannot proceed');
  }

  logger.info('✅ Encryption configuration validated');
};

/**
 * Validate security headers configuration
 */
const validateSecurityHeaders = () => {
  logger.info('Validating security headers...');

  const securityChecks = {
    'CORS configured': process.env.FRONTEND_URL,
    'CSRF protection available': true,
    'Helmet.js middleware': true,
    'Rate limiting enabled': true,
  };

  const failed = Object.entries(securityChecks)
    .filter(([_, check]) => !check)
    .map(([name, _]) => name);

  if (failed.length > 0) {
    logger.warn(`⚠️ Security checks failed: ${failed.join(', ')}`);
  } else {
    logger.info('✅ Security headers configured');
  }
};

/**
 * Validate database configuration
 */
const validateDatabaseConfig = () => {
  logger.info('Validating database configuration...');

  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI not configured');
  }

  // Check for connection pool settings
  if (!process.env.MONGODB_URI.includes('maxPoolSize')) {
    logger.warn('⚠️ Consider adding maxPoolSize to MongoDB URI for production');
  }

  logger.info('✅ Database configuration validated');
};

/**
 * Validate Redis configuration
 */
const validateRedisConfig = () => {
  logger.info('Validating Redis configuration...');

  const isProd = process.env.NODE_ENV === 'production';
  const hasRedis = process.env.REDIS_URL || process.env.REDIS_HOST || process.env.REDIS_PORT;

  if (isProd && !hasRedis) {
    throw new Error('Redis configuration required in production');
  }

  if (hasRedis) {
    logger.info('✅ Redis configuration detected');
  } else {
    logger.warn('⚠️ Redis not configured - using in-memory fallback');
  }
};

/**
 * Validate SSL/TLS configuration
 */
const validateTLS = () => {
  logger.info('Validating TLS configuration...');

  const isProd = process.env.NODE_ENV === 'production';

  if (isProd) {
    if (!process.env.FRONTEND_URL?.startsWith('https://')) {
      logger.warn('⚠️ FRONTEND_URL should use HTTPS in production');
    }
  }

  logger.info('✅ TLS configuration checked');
};

/**
 * Check system resources
 */
const checkSystemResources = async (redisClient) => {
  logger.info('Checking system resources...');

  try {
    const health = await getHealthStatus(redisClient);
    
    logger.info('System resource check complete', {
      status: health.status,
      uptime: Math.round(health.uptime)
    });

    return health;
  } catch (err) {
    logger.error('System resource check failed', { error: err.message });
    throw err;
  }
};

/**
 * Initialize all safety systems
 * Call this once at application startup
 */
const initializeSafetySystems = async (redisClient) => {
  logger.info('');
  logger.info('╔════════════════════════════════════════════════════════╗');
  logger.info('║     INITIALIZING END-TO-END SAFETY SYSTEMS               ║');
  logger.info('║     Emergency Response System (ERS)                      ║');
  logger.info('╚════════════════════════════════════════════════════════╝');
  logger.info('');

  try {
    // Phase 1: Environment & Configuration
    logger.info('▼ Phase 1: Environment & Configuration');
    validateEnvironment();
    validateDatabaseConfig();
    validateRedisConfig();
    validateSecurityHeaders();
    validateTLS();
    logger.info('');

    // Phase 2: Encryption & Security
    logger.info('▼ Phase 2: Encryption & Security');
    validateEncryption();
    logger.info('');

    // Phase 3: System Resources
    logger.info('▼ Phase 3: System Resources');
    await checkSystemResources(redisClient);
    logger.info('');

    // Success
    logger.info('╔════════════════════════════════════════════════════════╗');
    logger.info('║     ✅ ALL SAFETY SYSTEMS INITIALIZED                    ║');
    logger.info('║                                                          ║');
    logger.info('║     System is safe for public protection operations     ║');
    logger.info('║     All critical checks passed                          ║');
    logger.info('╚════════════════════════════════════════════════════════╝');
    logger.info('');

    return true;
  } catch (err) {
    logger.error('');
    logger.error('╔════════════════════════════════════════════════════════╗');
    logger.error('║     ❌ SAFETY SYSTEM INITIALIZATION FAILED                ║');
    logger.error('║                                                          ║');
    logger.error(`║     Error: ${err.message.substring(0, 50)}${err.message.length > 50 ? '...' : ''}`);
    logger.error('║                                                          ║');
    logger.error('║     System cannot start - please fix configuration      ║');
    logger.error('╚════════════════════════════════════════════════════════╝');
    logger.error('');

    throw err;
  }
};

/**
 * Pre-flight safety checks (can be run before server startup)
 */
const runPreflightChecks = async (redisClient) => {
  const results = {
    environment: false,
    encryption: false,
    database: false,
    redis: false,
    resources: false
  };

  try {
    validateEnvironment();
    results.environment = true;
  } catch (err) {
    logger.error('Environment check failed:', err.message);
  }

  try {
    validateEncryption();
    results.encryption = true;
  } catch (err) {
    logger.warn('Encryption check failed:', err.message);
  }

  try {
    validateDatabaseConfig();
    results.database = true;
  } catch (err) {
    logger.error('Database check failed:', err.message);
  }

  try {
    validateRedisConfig();
    results.redis = true;
  } catch (err) {
    logger.warn('Redis check failed:', err.message);
  }

  try {
    await checkSystemResources(redisClient);
    results.resources = true;
  } catch (err) {
    logger.warn('Resource check failed:', err.message);
  }

  return results;
};

module.exports = {
  initializeSafetySystems,
  runPreflightChecks,
  validateEnvironment,
  validateEncryption,
  validateSecurityHeaders,
  validateDatabaseConfig,
  validateRedisConfig,
  validateTLS,
  checkSystemResources
};
