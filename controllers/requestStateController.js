'use strict';

const mongoose = require('mongoose');
const EmergencyRequest = require('../models/EmergencyRequest');
const Ambulance = require('../models/Ambulance');
const DispatchLog = require('../models/DispatchLog');
const AppError = require('../utils/AppError');
const RequestStateMachine = require('../utils/requestStateMachine');
const eventConsistency = require('../utils/eventConsistency');
const { AuditLogger } = require('../models/AuditLog');
const realtimeMonitor = require('../utils/realtimeMonitor');
const logger = require('../utils/logger');
const { AMBULANCE_STATUS, REQUEST_STATUS, ROLES } = require('../utils/constants');
const { addDispatchJob } = require('../utils/dispatchQueue');

/**
 * Driver accepts assignment
 * ASSIGNED → ACCEPTED
 */
exports.acceptAssignment = async (req, res, next) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { requestId } = req.params;
    const driver = await Ambulance.findOne({ driverId: req.user._id }).session(session);

    if (!driver) {
      throw new AppError('Driver ambulance not found', 404);
    }

    const request = await EmergencyRequest.findById(requestId).session(session);
    if (!request) {
      throw new AppError('Emergency request not found', 404);
    }

    if (!request.assignedAmbulanceId.equals(driver._id)) {
      throw new AppError('This request is not assigned to your ambulance', 403);
    }

    // Use state machine to validate transition
    const stateMachine = new RequestStateMachine(request);
    if (!stateMachine.canAccept()) {
      throw new AppError(
        `Cannot accept request in state: ${request.status}. Request must be ASSIGNED.`,
        400
      );
    }

    // Check freshness to prevent stale updates
    const isFresh = await eventConsistency.isUpdateFresh(requestId, 1);
    if (!isFresh) {
      throw new AppError('This request has been updated by another user', 409);
    }

    // Transition state
    const transition = await stateMachine.transitionTo('ACCEPTED', {
      driverId: req.user._id,
      timestamp: new Date(),
    });

    // Update request
    request.status = REQUEST_STATUS.ACCEPTED;
    request.acceptedAt = new Date();
    await request.save({ session });

    // Publish event
    await eventConsistency.publishEvent({
      type: 'REQUEST_ACCEPTED',
      requestId: request._id,
      data: { driverId: req.user._id, ambulanceId: driver._id },
      version: 1,
    });

    // Audit log
    await AuditLogger.log(
      'REQUEST_ACCEPTED',
      { type: 'REQUEST', id: request._id },
      req.user._id,
      { status: 'ACCEPTED' },
      {
        correlationId: req.requestId,
        priority: request.priority,
      }
    );

    await session.commitTransaction();

    // Update real-time monitoring metrics
    await realtimeMonitor.updateRequestStatus(
      request._id,
      request.status,
      'ACCEPTED',
      {
        driverId: req.user._id.toString(),
        ambulanceId: driver._id.toString(),
        acceptedTime: new Date(),
      }
    );

    const io = req.app.get('io');
    if (io) {
      io.to(`request_${request._id}`).emit('requestAccepted', {
        requestId: request._id,
        driverId: req.user._id,
        ambulanceId: driver._id,
      });
      io.to(`user_${request.userId}`).emit('ambulanceAccepted', {
        requestId: request._id,
        ambulancePlate: driver.plateNumber,
      });
    }

    res.status(200).json({
      success: true,
      message: 'Assignment accepted',
      data: request,
    });
  } catch (err) {
    await session.abortTransaction();
    next(err);
  } finally {
    session.endSession();
  }
};

/**
 * Driver rejects assignment
 * ASSIGNED → REJECTED
 */
exports.rejectAssignment = async (req, res, next) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { requestId } = req.params;
    const { reason } = req.body;

    const driver = await Ambulance.findOne({ driverId: req.user._id }).session(session);
    if (!driver) {
      throw new AppError('Driver ambulance not found', 404);
    }

    const request = await EmergencyRequest.findById(requestId).session(session);
    if (!request) {
      throw new AppError('Emergency request not found', 404);
    }

    if (!request.assignedAmbulanceId.equals(driver._id)) {
      throw new AppError('This request is not assigned to your ambulance', 403);
    }

    // Use state machine to validate transition
    const stateMachine = new RequestStateMachine(request);
    if (!stateMachine.canReject()) {
      throw new AppError(
        `Cannot reject request in state: ${request.status}. Request must be ASSIGNED.`,
        400
      );
    }

    // Transition state
    await stateMachine.transitionTo('REJECTED', {
      driverId: req.user._id,
      reason,
      timestamp: new Date(),
    });

    // Update request
    request.status = REQUEST_STATUS.PENDING;
    request.assignedAmbulanceId = undefined;
    request.rejectionCount = (request.rejectionCount || 0) + 1;
    await request.save({ session });

    // Free ambulance
    driver.status = AMBULANCE_STATUS.AVAILABLE;
    await driver.save({ session });

    // Publish event
    await eventConsistency.publishEvent({
      type: 'REQUEST_REJECTED',
      requestId: request._id,
      data: { driverId: req.user._id, reason },
      version: 1,
    });

    // Audit log
    await AuditLogger.log(
      'REQUEST_REJECTED',
      { type: 'REQUEST', id: request._id },
      req.user._id,
      { reason, rejectionCount: request.rejectionCount },
      {
        correlationId: req.requestId,
        priority: request.priority,
      }
    );

    await session.commitTransaction();

    // Queue retry job (AFTER commit)
    const priorityMap = { CRITICAL: 3, HIGH: 2, MEDIUM: 1, LOW: 0 };
    const jobPriority = priorityMap[request.priority] || 1;
    await addDispatchJob(requestId, 'retry', driver._id.toString(), jobPriority);

    // Update real-time monitoring metrics (AFTER commit)
    await realtimeMonitor.updateRequestStatus(
      request._id,
      request.status,
      'REJECTED',
      {
        driverId: req.user._id.toString(),
        ambulanceId: driver._id.toString(),
        reason,
        rejectionCount: request.rejectionCount,
      }
    );
    await realtimeMonitor.updateAmbulanceStatus(
      driver._id,
      'AVAILABLE',
      {
        lastRejectionReason: reason,
        lastRejectionTime: new Date(),
      }
    );

    const io = req.app.get('io');
    if (io) {
      io.to('dispatchers').emit('requestRejected', {
        requestId: request._id,
        driverId: req.user._id,
        reason,
      });
      io.to(`user_${request.userId}`).emit('ambulanceRejected', {
        requestId: request._id,
        reason: 'Driver unable to accept',
      });
    }

    res.status(200).json({
      success: true,
      message: 'Assignment rejected, seeking alternative ambulance',
      data: request,
    });
  } catch (err) {
    await session.abortTransaction();
    next(err);
  } finally {
    session.endSession();
  }
};

/**
 * Driver marks en route
 * ACCEPTED → EN_ROUTE
 */
exports.markEnRoute = async (req, res, next) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { requestId } = req.params;

    const driver = await Ambulance.findOne({ driverId: req.user._id }).session(session);
    if (!driver) throw new AppError('Driver ambulance not found', 404);

    const request = await EmergencyRequest.findById(requestId).session(session);
    if (!request) throw new AppError('Emergency request not found', 404);

    const stateMachine = new RequestStateMachine(request);
    if (!stateMachine.canMarkEnRoute()) {
      throw new AppError(`Cannot mark en route in state: ${request.status}`, 400);
    }

    await stateMachine.transitionTo('EN_ROUTE', { driverId: req.user._id });

    request.status = REQUEST_STATUS.EN_ROUTE;
    request.enRouteAt = new Date();
    driver.status = AMBULANCE_STATUS.EN_ROUTE;

    await Promise.all([request.save({ session }), driver.save({ session })]);

    await eventConsistency.publishEvent({
      type: 'REQUEST_EN_ROUTE',
      requestId: request._id,
      data: { driverId: req.user._id },
      version: 1,
    });

    await AuditLogger.log(
      'REQUEST_EN_ROUTE',
      { type: 'REQUEST', id: request._id },
      req.user._id,
      {},
      { correlationId: req.requestId }
    );

    await session.commitTransaction();

    // Update real-time monitoring metrics
    await realtimeMonitor.updateRequestStatus(
      request._id,
      request.status,
      'EN_ROUTE',
      {
        driverId: req.user._id.toString(),
        ambulanceId: driver._id.toString(),
        enRouteTime: new Date(),
      }
    );
    await realtimeMonitor.updateAmbulanceStatus(
      driver._id,
      AMBULANCE_STATUS.EN_ROUTE,
      {
        currentRequestId: request._id.toString(),
        location: driver.currentLocation,
      }
    );

    const io = req.app.get('io');
    if (io) {
      io.to(`request_${request._id}`).emit('requestEnRoute', { requestId: request._id });
      io.to(`user_${request.userId}`).emit('ambulanceEnRoute', { requestId: request._id });
    }

    res.json({ success: true, data: request });
  } catch (err) {
    await session.abortTransaction();
    next(err);
  } finally {
    session.endSession();
  }
};

/**
 * Get request state with full audit trail
 */
exports.getRequestState = async (req, res, next) => {
  try {
    const { requestId } = req.params;

    const request = await EmergencyRequest.findById(requestId)
      .populate('userId', 'name phone')
      .populate('assignedAmbulanceId', 'plateNumber')
      .lean();

    if (!request) throw new AppError('Request not found', 404);

    // Get event sequence
    const events = await eventConsistency.getEventSequence(requestId);

    res.json({
      success: true,
      data: {
        request,
        events,
      },
    });
  } catch (err) {
    next(err);
  }
};

module.exports = exports;