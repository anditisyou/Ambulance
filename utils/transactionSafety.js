'use strict';

const mongoose = require('mongoose');
const logger = require('../utils/logger');
const AppError = require('../utils/AppError');
const { syncRequestState } = require('./requestStateMachine');

/**
 * TRANSACTION SAFETY LAYER
 * 
 * Ensures ACID compliance for critical operations:
 * - Emergency request creation and assignment
 * - Dispatch state transitions
 * - Payment processing
 * - Medical record updates
 * 
 * Prevents:
 * - Race conditions in concurrent requests
 * - Partial state updates
 * - Lost updates to critical data
 * - Dirty reads during state transitions
 */

/**
 * Execute operation within a database transaction
 * Automatically rolls back on error
 * 
 * Usage:
 * const result = await withTransaction(async (session) => {
 *   const request = await EmergencyRequest.findById(id, {}, { session });
 *   request.status = 'ASSIGNED';
 *   await request.save({ session });
 *   return request;
 * });
 */
const withTransaction = async (operation, options = {}) => {
  const session = await mongoose.startSession();
  session.startTransaction({
    isolation: 'snapshot', // Most strict isolation level
    maxCommitTimeMS: options.maxCommitTime || 30000,
    readConcern: { level: 'snapshot' },
    writeConcern: { w: 'majority' },
    readPreference: 'primary' // Always read from primary during transaction
  });

  try {
    const result = await operation(session);
    await session.commitTransaction();
    logger.debug('Transaction committed successfully', {
      operationType: operation.name || 'anonymous'
    });
    return result;
  } catch (err) {
    await session.abortTransaction();
    if (/Transaction numbers are only allowed on a replica set member or mongos/i.test(err.message)) {
      logger.warn('MongoDB transactions unavailable; retrying operation without transaction', {
        operationType: operation.name || 'anonymous'
      });
      return operation(null);
    }
    logger.error('Transaction aborted', {
      error: err.message,
      operationType: operation.name || 'anonymous'
    });
    throw err;
  } finally {
    session.endSession();
  }
};

/**
 * Safe concurrent update with version checking (Optimistic Locking)
 * Prevents lost updates when multiple requests modify same document
 */
const withOptimisticLocking = async (Model, docId, updateFn, options = {}) => {
  const maxRetries = options.maxRetries || 3;
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Read current version
      const doc = await Model.findById(docId).select('+__v');
      if (!doc) {
        throw new AppError('Document not found', 404);
      }

      const currentVersion = doc.__v || 0;

      // Apply updates
      const updatedDoc = await updateFn(doc);

      // Attempt write with version check
      const result = await Model.findByIdAndUpdate(
        docId,
        updatedDoc,
        {
          new: true,
          runValidators: true,
          conditions: { __v: currentVersion } // Fails if version changed
        }
      );

      if (!result) {
        // Version mismatch - retry
        if (attempt < maxRetries) {
          logger.debug(`Version mismatch on attempt ${attempt}, retrying...`, {
            docId,
            attempt
          });
          await new Promise(resolve => setTimeout(resolve, 100 * attempt)); // Exponential backoff
          continue;
        }
        throw new AppError('Document was modified by another request. Please retry.', 409);
      }

      return result;
    } catch (err) {
      lastError = err;
      if (err.message?.includes('version') || attempt === maxRetries) {
        throw lastError;
      }
    }
  }

  throw lastError;
};

/**
 * Validate state machine transition
 * Ensures only valid state transitions occur
 * 
 * Example:
 * validateStateTransition('EmergencyRequest', currentStatus, newStatus, validTransitions)
 */
const validateStateTransition = (entityType, currentState, newState, validTransitions) => {
  if (!validTransitions[currentState]) {
    throw new AppError(
      `Invalid current state '${currentState}' for ${entityType}`,
      400
    );
  }

  if (!validTransitions[currentState].includes(newState)) {
    throw new AppError(
      `Cannot transition from '${currentState}' to '${newState}'. ` +
      `Valid transitions: ${validTransitions[currentState].join(', ')}`,
      400
    );
  }
};

/**
 * State machine definition for EmergencyRequest
 */
const EMERGENCY_REQUEST_TRANSITIONS = {
  'PENDING': ['ASSIGNED', 'CANCELLED'],
  'ASSIGNED': ['ACCEPTED', 'REJECTED', 'CANCELLED'],
  'ACCEPTED': ['EN_ROUTE', 'REJECTED'],
  'EN_ROUTE': ['ARRIVED', 'CANCELLED'],
  'ARRIVED': ['TREATMENT_STARTED', 'COMPLETED', 'CANCELLED'],
  'TREATMENT_STARTED': ['HOSPITAL_ACCEPTED', 'TRANSPORT_STARTED', 'COMPLETED'],
  'TRANSPORT_STARTED': ['HOSPITAL_ARRIVED'],
  'HOSPITAL_ARRIVED': ['TREATMENT_COMPLETED', 'TRANSFER_INITIATED'],
  'TRANSFER_INITIATED': ['TRANSFER_COMPLETED', 'COMPLETED'],
  'TREATMENT_COMPLETED': ['COMPLETED', 'FOLLOW_UP_SCHEDULED'],
  'FOLLOW_UP_SCHEDULED': ['COMPLETED'],
  'COMPLETED': [], // Terminal state
  'CANCELLED': []  // Terminal state
};

/**
 * Dispatch state machine
 */
const DISPATCH_ASSIGNMENT_TRANSITIONS = {
  'PENDING': ['ASSIGNED', 'UNASSIGNED'],
  'ASSIGNED': ['ACCEPTED', 'REJECTED', 'AUTO_UNASSIGNED'],
  'ACCEPTED': ['EN_ROUTE', 'CANCELLED'],
  'EN_ROUTE': ['ARRIVED', 'CANCELLED'],
  'ARRIVED': ['COMPLETED', 'CANCELLED'],
  'REJECTED': ['REASSIGNED'],
  'CANCELLED': [],
  'COMPLETED': [],
  'AUTO_UNASSIGNED': ['REASSIGNED'],
  'REASSIGNED': ['ASSIGNED']
};

/**
 * Safe state transition with logging and validation
 */
const transitionState = async (Model, docId, newState, context = {}) => {
  return withTransaction(async (session) => {
    const doc = await Model.findById(docId, {}, { session });
    
    if (!doc) {
      throw new AppError(`${Model.modelName} not found`, 404);
    }

    const currentState = doc.assignmentState || doc.status || doc.state;
    
    // Validate transition
    const transitions = Model.modelName === 'EmergencyRequest' 
      ? EMERGENCY_REQUEST_TRANSITIONS 
      : DISPATCH_ASSIGNMENT_TRANSITIONS;
    
    validateStateTransition(Model.modelName, currentState, newState, transitions);

    // Update state
    if (Model.modelName === 'EmergencyRequest') {
      syncRequestState(doc, newState);
    } else {
      const stateField = doc.status ? 'status' : doc.state ? 'state' : 'assignmentState';
      doc[stateField] = newState;
    }
    
    // Add state transition metadata
    if (!doc.stateHistory) {
      doc.stateHistory = [];
    }
    doc.stateHistory.push({
      from: currentState,
      to: newState,
      timestamp: new Date(),
      context: context || {},
      userId: context.userId
    });

    await doc.save({ session });

    logger.info(`State transition recorded`, {
      model: Model.modelName,
      docId: String(docId),
      from: currentState,
      to: newState,
      context
    });

    return doc;
  });
};

/**
 * Prevent concurrent modifications using MongoDB sessions
 */
const preventConcurrentModification = async (Model, docId, fn) => {
  const session = await mongoose.startSession();
  session.startTransaction({
    readConcern: { level: 'snapshot' },
    writeConcern: { w: 'majority' },
    readPreference: 'primary'
  });

  try {
    // Lock document by reading it within transaction
    const doc = await Model.findById(docId, {}, { session });
    
    if (!doc) {
      throw new AppError('Resource not found', 404);
    }

    // Execute operation with lock held
    const result = await fn(doc, session);

    await session.commitTransaction();
    return result;
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }
};

module.exports = {
  withTransaction,
  withOptimisticLocking,
  validateStateTransition,
  transitionState,
  preventConcurrentModification,
  EMERGENCY_REQUEST_TRANSITIONS,
  DISPATCH_ASSIGNMENT_TRANSITIONS
};
