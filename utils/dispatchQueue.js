'use strict';

const { Queue, Worker, QueueEvents } = require('bullmq');
const Redis = require('ioredis');
const mongoose = require('mongoose');
const logger = require('./logger');
const { allocateAmbulance, handleRejection } = require('./dispatchEngine');
const EmergencyRequest = require('../models/EmergencyRequest');
const Ambulance = require('../models/Ambulance');
const User = require('../models/User');
const { REQUEST_STATUS, AMBULANCE_STATUS } = require('./constants');
const { emitEvent } = require('./socketEmitter');
const {
  recordDispatchSuccess,
  recordDispatchFailure,
  recordDispatchRetry,
  setDispatchQueueStats,
  setDispatchQueueDepth,
  recordStuckRequests,
  getMetrics,
} = require('./metrics');
const AlertManager = require('./alerting');

const alertManager = new AlertManager();

// Redis connection for BullMQ (supports REDIS_URL and REDIS_HOST/PORT).
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
const redis = new Redis(redisConnection, {
  connectTimeout: 10000,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 3,
  retryStrategy: (times) => Math.min(times * 50, 2000),
  reconnectOnError: (err) => {
    if (err.message.includes('ETIMEDOUT') || err.message.includes('ECONNRESET')) {
      return true;
    }
    return false;
  },
  autoResubscribe: true,
});

const logRedisState = (event, err) => {
  if (err) logger.warn('[DispatchQueue Redis] ' + event + ':', err.message || err);
  else logger.info('[DispatchQueue Redis] ' + event);
};

redis.on('connect', () => logRedisState('Connected'));
redis.on('ready', () => logRedisState('Ready'));
redis.on('error', (err) => logRedisState('Error', err));
redis.on('close', () => logRedisState('Closed'));
redis.on('reconnecting', (delay) => logRedisState(`Reconnecting in ${delay}ms`));

const RECONCILIATION_LOCK_KEY = 'dispatch:reconcile:lock';
const RECONCILIATION_INTERVAL_MS = 60000; // 1 minute
const PENDING_STUCK_MS = 180000; // 3 minutes
const ORPHANED_ASSIGNMENT_AGE_MS = 300000; // 5 minutes
const QUEUE_LOCK_TTL_SECONDS = 300;

// Create queue with optimized settings
const dispatchQueue = new Queue('dispatch', {
  connection: redisConnection,
  defaultJobOptions: {
    removeOnComplete: 5, // Reduced to save memory
    removeOnFail: 10, // Reduced to save memory
    attempts: 2, // Reduced retry attempts
    backoff: {
      type: 'exponential',
      delay: 1000, // Faster initial retry
    },
  },
});

// Dead-letter queue for failed jobs
const dlq = new Queue('dispatch-dlq', { connection: redisConnection });

// Worker to process dispatch jobs
const dispatchWorker = new Worker('dispatch', async (job) => {
  const { requestId, action } = job.data;

  // Request-level lock: only one worker can process this request at a time.
  const processingKey = `processing:${requestId}`;
  const lockAcquired = await redis.set(processingKey, job.id, 'NX', 'EX', QUEUE_LOCK_TTL_SECONDS);
  if (!lockAcquired) {
    logger.warn('Skipping duplicate request processing - request lock already held', {
      jobId: job.id,
      requestId,
      action,
      requestLockKey: processingKey,
    });
    return null;
  }

  logger.info('Processing dispatch job', { jobId: job.id, requestId, action });

  const session = await mongoose.startSession();
  try {
    let result = null;

    await session.withTransaction(async () => {
      const request = await EmergencyRequest.findById(requestId).populate('assignedHospital').session(session);
      if (!request) throw new Error('Request not found');

      // Additional idempotency: only pending requests should be allocated.
      if (action === 'allocate' && request.status !== REQUEST_STATUS.PENDING) {
        logger.info('Skipping allocation - request not pending', { requestId, status: request.status });
        return;
      }

      if (action === 'allocate') {
        result = await allocateAmbulance(request, session, true, request.assignedHospital);
      } else if (action === 'retry') {
        result = await handleRejection(request, session, true);
      } else if (action === 'timeout-check') {
        const isExpectedAmbulance = request.assignedAmbulanceId &&
          String(request.assignedAmbulanceId) === String(job.data.ambulanceId);

        if (request.status === REQUEST_STATUS.ASSIGNED && isExpectedAmbulance) {
          logger.warn('Ambulance acceptance timeout, reassigning', { requestId, ambulanceId: job.data.ambulanceId });
          result = await handleRejection(request, session);
        }
      }

      if (!result) {
        const requestAfter = await EmergencyRequest.findById(requestId).session(session);
        if (!requestAfter) {
          throw new Error('Allocation failed: request not found after processing');
        }

        if (
          requestAfter.status === REQUEST_STATUS.PENDING ||
          requestAfter.status === REQUEST_STATUS.CANCELLED ||
          requestAfter.status === REQUEST_STATUS.EN_ROUTE ||
          requestAfter.status === REQUEST_STATUS.COMPLETED
        ) {
          logger.info('Dispatch job completed without a new assignment; request has progressed or remains pending', {
            requestId,
            action,
            currentStatus: requestAfter.status,
          });
          return;
        }

        if (requestAfter.status === REQUEST_STATUS.ASSIGNED && requestAfter.assignedAmbulanceId) {
          const assignedAmbulance = await Ambulance.findById(requestAfter.assignedAmbulanceId).session(session);
          if (assignedAmbulance) {
            result = assignedAmbulance;
          } else {
            throw new Error('Allocation failed: assigned ambulance not found');
          }
        } else {
          throw new Error(`Allocation failed: unexpected request status ${requestAfter.status}`);
        }
      }
    });

    session.endSession();

    // Clear processing flag on success
    await redis.del(processingKey);

    if (result) {
      // Add timeout job for acceptance when an assignment is made
      await addTimeoutJob(requestId, result._id.toString());
      await emitAllocationEvents(requestId, result);
    }

    return result;
  } catch (error) {
    session.endSession();
    // Clear processing flag on failure
    await redis.del(processingKey);
    logger.error('Dispatch job failed', { jobId: job.id, requestId, error: error.message });
    throw error;
  }
}, {
  connection: redisConnection,
  concurrency: parseInt(process.env.BULLMQ_CONCURRENCY) || 6, // Balanced concurrency for emergency response
  limiter: {
    max: 10, // Max jobs per duration
    duration: 1000, // Per second - prevents queue flooding
  },
});

// Function to emit socket events after allocation
const emitAllocationEvents = async (requestId, ambulance) => {
  try {
    const request = await EmergencyRequest.findById(requestId).populate('assignedHospital').lean();
    if (!request) return;

    const user = await User.findById(request.userId).lean();
    const driver = await User.findById(ambulance.driverId).lean();
    const eta = await estimateEta(ambulance.currentLocation.coordinates, request.location.coordinates);
    const etaMinutes = Math.round(eta / 60);

    // Emit to driver
    await emitEvent(`driver_${ambulance.driverId}`, 'dispatchAssigned', {
      requestId: request._id,
      location: request.location,
      priority: request.priority,
      eta: etaMinutes,
      patientName: user.name,
      patientPhone: user.phone,
      assignedHospital: request.assignedHospital ? {
        id: request.assignedHospital._id,
        name: request.assignedHospital.name,
      } : null,
    });

    // Emit to user
    await emitEvent(`user_${request.userId}`, 'ambulanceAssigned', {
      requestId: request._id,
      ambulanceId: ambulance._id,
      ambulancePlate: ambulance.plateNumber,
      eta: etaMinutes,
      assignedHospital: request.assignedHospital,
    });

    // Emit to dispatchers
    await emitEvent('dispatchers', 'dispatchAllocated', {
      requestId: request._id,
      ambulanceId: ambulance._id,
    });

    logger.info('Allocation events emitted', { requestId, ambulanceId: ambulance._id });
  } catch (error) {
    logger.error('Failed to emit allocation events', { requestId, error: error.message });
  }
};

// Function to emit failure events
const emitFailureEvents = async (requestId, errorMessage, request) => {
  try {
    const user = await User.findById(request.userId).lean();

    // Notify user
    await emitEvent(`user_${request.userId}`, 'requestFailed', {
      requestId,
      reason: errorMessage,
      userName: user?.name,
    });

    // Notify admins
    await emitEvent('admins', 'dispatchFailure', {
      requestId,
      error: errorMessage,
      priority: request.priority,
      userName: user?.name,
    });

    logger.info('Failure events emitted', { requestId, error: errorMessage });
  } catch (error) {
    logger.error('Failed to emit failure events', { requestId, error: error.message });
  }
};

const updateQueueDepth = async () => {
  try {
    const stats = await getQueueStats();
    setDispatchQueueStats(stats);
    alertManager.checkThresholds(getMetrics());
    return stats.waiting + stats.active + stats.delayed;
  } catch (err) {
    logger.error('Failed to update dispatch queue depth', { error: err.message });
    return 0;
  }
};

let cachedQueueStats = { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 };
let lastQueueStatsAt = 0;
const QUEUE_STATS_TTL_MS = 5000;

const refreshQueueStats = async (force = false) => {
  const now = Date.now();
  if (!force && now - lastQueueStatsAt < QUEUE_STATS_TTL_MS) {
    return cachedQueueStats;
  }

  const counts = await dispatchQueue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed');
  cachedQueueStats = {
    waiting: counts.waiting || 0,
    active: counts.active || 0,
    completed: counts.completed || 0,
    failed: counts.failed || 0,
    delayed: counts.delayed || 0,
  };
  lastQueueStatsAt = now;
  return cachedQueueStats;
};

const getTrackedRequestIds = async () => {
  const jobs = await dispatchQueue.getJobs(['waiting', 'active', 'delayed'], 0, 1000);
  return new Set(jobs.map((job) => String(job.data.requestId)));
};

const reconcileDispatchState = async () => {
  const lock = await redis.set(RECONCILIATION_LOCK_KEY, '1', 'NX', 'EX', 30);
  if (!lock) return;

  try {
    logger.info('Starting dispatch reconciliation pass');

    const trackedRequestIds = await getTrackedRequestIds();
    const stuckPendingRequests = await EmergencyRequest.find({
      status: REQUEST_STATUS.PENDING,
      requestTime: { $lte: new Date(Date.now() - PENDING_STUCK_MS) },
    }).limit(200).lean();

    const stuckCount = stuckPendingRequests.length;
    recordStuckRequests(stuckCount);
    if (stuckCount > 0) {
      logger.warn('Detected stuck pending requests during reconciliation', { stuckCount });
    }

    for (const request of stuckPendingRequests) {
      const requestId = String(request._id);
      if (!trackedRequestIds.has(requestId)) {
        logger.warn('Requeuing stuck pending request', { requestId, priority: request.priority });
        await addDispatchJob(requestId, 'allocate', null, 3);
      }
    }

    const orphanedAssignedRequests = await EmergencyRequest.find({
      status: REQUEST_STATUS.ASSIGNED,
      assignedAmbulanceId: { $exists: true, $ne: null },
      allocationTime: { $lte: new Date(Date.now() - ORPHANED_ASSIGNMENT_AGE_MS) },
    })
      .populate('assignedAmbulanceId')
      .limit(200);

    for (const request of orphanedAssignedRequests) {
      const ambulance = request.assignedAmbulanceId;
      const requestId = String(request._id);
      const ambulanceId = ambulance?._id ? String(ambulance._id) : null;

      const isAmbulanceValid = ambulance && [AMBULANCE_STATUS.ASSIGNED, AMBULANCE_STATUS.EN_ROUTE].includes(ambulance.status);
      if (!isAmbulanceValid) {
        logger.warn('Found orphaned assigned request; resetting and requeuing', { requestId, ambulanceId, ambulanceStatus: ambulance?.status });

        await EmergencyRequest.findByIdAndUpdate(requestId, {
          status: REQUEST_STATUS.PENDING,
          assignmentState: 'PENDING',
          assignedAmbulanceId: undefined,
          assignmentAcceptanceDeadline: undefined,
          rejectionReason: 'Reconciliation repair',
          rejectionTime: new Date(),
        });

        if (ambulance && [AMBULANCE_STATUS.AVAILABLE, AMBULANCE_STATUS.MAINTENANCE].includes(ambulance.status)) {
          await Ambulance.findByIdAndUpdate(ambulance._id, { status: AMBULANCE_STATUS.AVAILABLE });
        }

        await addDispatchJob(requestId, 'allocate', null, 3);
        continue;
      }

      if (ambulance.status === AMBULANCE_STATUS.EN_ROUTE && request.status !== REQUEST_STATUS.EN_ROUTE) {
        logger.info('Repairing EN_ROUTE state from orphaned assignment', { requestId, ambulanceId });
        await EmergencyRequest.findByIdAndUpdate(requestId, {
          status: REQUEST_STATUS.EN_ROUTE,
          assignmentState: 'EN_ROUTE',
        });
      }

      if (ambulance.status === AMBULANCE_STATUS.ASSIGNED) {
        await EmergencyRequest.findByIdAndUpdate(requestId, { assignmentState: 'ASSIGNED' });
      }
    }

    await updateQueueDepth();
    alertManager.checkThresholds(getMetrics());
    logger.info('Dispatch reconciliation pass complete');
  } catch (err) {
    logger.error('Dispatch reconciliation failed', { error: err.message });
  } finally {
    await redis.del(RECONCILIATION_LOCK_KEY);
  }
};

let reconciliationInterval = null;

const startReconciliationLoop = () => {
  if (reconciliationInterval) return;
  reconciliationInterval = setInterval(() => {
    reconcileDispatchState().catch((err) => {
      logger.error('Reconciliation loop execution failed', { error: err.message });
    });
  }, RECONCILIATION_INTERVAL_MS);
  return reconciliationInterval;
};

const stopReconciliationLoop = async () => {
  if (reconciliationInterval) {
    clearInterval(reconciliationInterval);
    reconciliationInterval = null;
  }
};

const verifyRequestAmbulanceConsistency = async () => {
  logger.info('Starting request/ambulance consistency verification');

  const assignedRequests = await EmergencyRequest.aggregate([
    {
      $match: {
        status: { $in: [REQUEST_STATUS.ASSIGNED, REQUEST_STATUS.EN_ROUTE] },
        assignedAmbulanceId: { $exists: true, $ne: null },
      },
    },
    {
      $lookup: {
        from: 'ambulances',
        localField: 'assignedAmbulanceId',
        foreignField: '_id',
        as: 'ambulance',
      },
    },
    { $unwind: { path: '$ambulance', preserveNullAndEmptyArrays: true } },
  ]).exec();

  let repairCount = 0;

  for (const item of assignedRequests) {
    const requestId = String(item._id);
    const requestStatus = item.status;
    const ambulance = item.ambulance;
    const ambulanceId = ambulance?._id ? String(ambulance._id) : null;

    if (!ambulanceId) {
      logger.warn('Consistency violation: request assigned to missing ambulance', { requestId, requestStatus });
      await EmergencyRequest.findByIdAndUpdate(requestId, {
        status: REQUEST_STATUS.PENDING,
        assignmentState: 'PENDING',
        assignedAmbulanceId: undefined,
        assignmentAcceptanceDeadline: undefined,
        rejectionReason: 'Consistency repair: missing ambulance',
        rejectionTime: new Date(),
      });
      repairCount++;
      continue;
    }

    const ambulanceStatus = ambulance.status;

    if (requestStatus === REQUEST_STATUS.ASSIGNED && ambulanceStatus !== AMBULANCE_STATUS.ASSIGNED) {
      logger.warn('Consistency violation: request ASSIGNED but ambulance is not ASSIGNED', { requestId, ambulanceId, ambulanceStatus });
      if (ambulanceStatus === AMBULANCE_STATUS.EN_ROUTE) {
        await EmergencyRequest.findByIdAndUpdate(requestId, {
          status: REQUEST_STATUS.EN_ROUTE,
          assignmentState: 'EN_ROUTE',
        });
      } else {
        await EmergencyRequest.findByIdAndUpdate(requestId, {
          status: REQUEST_STATUS.PENDING,
          assignmentState: 'PENDING',
          assignedAmbulanceId: undefined,
          assignmentAcceptanceDeadline: undefined,
          rejectionReason: 'Consistency repair: ambulance state mismatch',
          rejectionTime: new Date(),
        });
        await Ambulance.findByIdAndUpdate(ambulanceId, { status: AMBULANCE_STATUS.AVAILABLE });
      }
      repairCount++;
    }

    if (requestStatus === REQUEST_STATUS.EN_ROUTE && ambulanceStatus !== AMBULANCE_STATUS.EN_ROUTE) {
      logger.warn('Consistency violation: request EN_ROUTE but ambulance is not EN_ROUTE', { requestId, ambulanceId, ambulanceStatus });
      await EmergencyRequest.findByIdAndUpdate(requestId, {
        status: REQUEST_STATUS.ASSIGNED,
        assignmentState: 'ASSIGNED',
      });
      repairCount++;
    }
  }

  if (repairCount > 0) {
    logger.warn('Completed request/ambulance consistency repair pass', { repairCount });
  }
};

const recoverDispatchState = async () => {
  await verifyRequestAmbulanceConsistency();
  await reconcileDispatchState();
  await updateQueueDepth();
};

// Estimate ETA (copied from dispatchController)
const estimateEta = async (from, to) => {
  // Simplified, use haversine for now
  const { haversineDistance } = require('./haversine');
  const seconds = haversineDistance(from[1], from[0], to[1], to[0]) / ((40 * 1000) / 3600);
  return Math.round(seconds);
};

// Handle job completion
dispatchWorker.on('completed', async (job, result) => {
  logger.info('Dispatch job completed', {
    jobId: job.id,
    requestId: job.data.requestId,
    action: job.data.action,
    ambulanceId: result?._id?.toString(),
    status: REQUEST_STATUS.ASSIGNED,
  });
  recordDispatchSuccess();
  await updateQueueDepth();
});

// Handle job failure
dispatchWorker.on('error', (err) => {
  logger.error('Dispatch worker encountered an error', { error: err.message });
});

dispatchWorker.on('failed', async (job, err) => {
  const requestId = job.data?.requestId;
  const action = job.data?.action;
  const maxAttempts = job.opts?.attempts || 1;
  const isFinalFailure = job.attemptsMade >= maxAttempts;

  logger.error('Dispatch job failed', {
    jobId: job.id,
    requestId,
    action,
    error: err.message,
    attempt: job.attemptsMade,
    maxAttempts,
    status: isFinalFailure ? 'FINAL_FAILURE' : 'RETRYING',
  });

  if (!isFinalFailure) {
    recordDispatchRetry();
    logger.warn('Dispatch job will retry', { jobId: job.id, requestId, action, nextAttempt: job.attemptsMade + 1 });
  } else {
    recordDispatchFailure();
  }

  await updateQueueDepth();

  if (isFinalFailure) {
    try {
      const request = await EmergencyRequest.findById(requestId);
      if (request && request.status === REQUEST_STATUS.PENDING) {
        if (action === 'allocate' || action === 'retry' || action === 'timeout-check') {
          logger.warn('Dispatch job permanently failed for pending request', {
            requestId,
            action,
            attempts: job.attemptsMade,
          });
          await emitFailureEvents(requestId, err.message, request);
        }
      }
    } catch (updateErr) {
      logger.error('Failed to signal request failure on job failure', {
        requestId,
        updateErr: updateErr.message,
      });
    }
  }

  // Move to dead-letter queue for later investigation
  await dlq.add('failed-dispatch', {
    originalJobId: job.id,
    requestId,
    error: err.message,
    attempts: job.attemptsMade,
  });
});

// Queue events for monitoring
const queueEvents = new QueueEvents('dispatch', { connection: redisConnection });

queueEvents.on('waiting', async ({ jobId }) => {
  logger.debug('Job waiting', { jobId });
  await updateQueueDepth();
});

queueEvents.on('active', async ({ jobId }) => {
  logger.debug('Job active', { jobId });
  await updateQueueDepth();
});

queueEvents.on('completed', async ({ jobId }) => {
  logger.debug('Job completed', { jobId });
  await updateQueueDepth();
});

queueEvents.on('failed', async ({ jobId, failedReason }) => {
  logger.warn('Job failed', { jobId, failedReason });
  await updateQueueDepth();
});

// Keep queue stats fresh on an interval to avoid expensive per-request scans.
setInterval(() => {
  refreshQueueStats(true)
    .then((stats) => {
      setDispatchQueueStats(stats);
      alertManager.checkThresholds(getMetrics());
    })
    .catch((err) => logger.error('Periodic queue stats refresh failed', { error: err.message }));
}, QUEUE_STATS_TTL_MS).unref();

// Function to add dispatch job
const addDispatchJob = async (requestId, action = 'allocate', rejectedAmbulanceId = null, priority = 1) => {
  const job = await dispatchQueue.add('dispatch-request', {
    requestId,
    action,
    rejectedAmbulanceId,
  }, {
    priority, // Higher number = higher priority
  });

  logger.info('Added dispatch job', { jobId: job.id, requestId, action, priority });
  await updateQueueDepth();
  return job;
};

// Function to get queue stats
const getQueueStats = async () => {
  return refreshQueueStats();
};

// Function to add timeout job for ambulance acceptance
const addTimeoutJob = async (requestId, ambulanceId, timeoutMs = 300000) => { // 5 min default
  const job = await dispatchQueue.add('timeout-check', {
    requestId,
    ambulanceId,
  }, {
    delay: timeoutMs,
    priority: 2, // High priority
  });

  logger.info('Added timeout job', { jobId: job.id, requestId, ambulanceId, timeoutMs });
  return job;
};

module.exports = {
  addDispatchJob,
  getQueueStats,
  addTimeoutJob,
  dispatchWorker,
  queueEvents,
  startReconciliationLoop,
  stopReconciliationLoop,
  recoverDispatchState,
};
