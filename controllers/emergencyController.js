'use strict';

const mongoose          = require('mongoose');
const EmergencyRequest  = require('../models/EmergencyRequest');
const Ambulance         = require('../models/Ambulance');
const DispatchLog       = require('../models/DispatchLog'); // FIX: was missing — caused ReferenceError
const User              = require('../models/User');
const AppError          = require('../utils/AppError');
const {
  ROLES,
  REQUEST_STATUS,
  REQUEST_STATUS_VALUES,
  AMBULANCE_STATUS,
} = require('../utils/constants');

// ─── GET /api/emergency ───────────────────────────────────────────────────────

/**
 * @desc  Get emergency requests (role-filtered)
 * @route GET /api/emergency
 * @access Private (Hospital, Driver, Dispatcher, Admin, Citizen)
 */
exports.getEmergencyRequests = async (req, res, next) => {
  try {
    const {
      status,
      priority,
      startDate,
      endDate,
      limit   = 50,
      page    = 1,
      sortBy  = '-requestTime',
    } = req.query;

    const pageNum  = Math.max(1, parseInt(page,  10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
    const skip     = (pageNum - 1) * limitNum;

    let query = {};

    switch (req.user.role) {
      case ROLES.HOSPITAL:
        // Hospitals should see new PENDING requests, requests assigned to them,
        // and also requests that are ASSIGNED to an ambulance but have no hospital selected yet.
        query = {
          $or: [
            { status: REQUEST_STATUS.PENDING },
            { assignedHospital: req.user._id },
            { status: REQUEST_STATUS.ASSIGNED, assignedHospital: { $exists: false } },
          ],
        };
        break;

      case ROLES.DRIVER: {
        // FIX: `const` inside switch case requires a block scope
        const ambulance = await Ambulance.findOne({ driverId: req.user._id }).lean();
        if (!ambulance) {
          return res.status(200).json({ success: true, count: 0, total: 0, data: [] });
        }
        query.assignedAmbulanceId = ambulance._id;
        break;
      }

      case ROLES.ADMIN:
      case ROLES.DISPATCHER:
        if (status) {
          if (!REQUEST_STATUS_VALUES.includes(status)) {
            throw new AppError('Invalid status filter', 400);
          }
          query.status = status;
        }
        if (priority) query.priority = priority;
        if (startDate || endDate) {
          query.requestTime = {};
          if (startDate) query.requestTime.$gte = new Date(startDate);
          if (endDate)   query.requestTime.$lte = new Date(endDate);
        }
        break;

      case ROLES.CITIZEN:
        query.userId = req.user._id;
        break;

      default:
        throw new AppError('Unauthorised role', 403);
    }

    const [requests, total] = await Promise.all([
      EmergencyRequest.find(query)
        .populate('userId', 'name email phone')
        .populate('assignedAmbulanceId', 'plateNumber driverId')
        .populate('assignedHospital', 'name')
        .sort(sortBy)
        .skip(skip)
        .limit(limitNum)
        .lean({ virtuals: false }), // Use lean for better performance
      EmergencyRequest.countDocuments(query),
    ]);

    // FIX: avoid N+1 — collect all unique driverIds and batch-fetch
    const driverIds = [
      ...new Set(
        requests
          .map((r) => r.assignedAmbulanceId?.driverId)
          .filter(Boolean)
          .map(String)
      ),
    ];

    // Only fetch drivers if we have any to fetch
    const driversMap = driverIds.length > 0
      ? await User.find({ _id: { $in: driverIds } })
          .select('name phone')
          .lean()
          .then((arr) => Object.fromEntries(arr.map((d) => [String(d._id), d])))
      : {};

    const enhanced = requests.map((r) => {
      const dId = r.assignedAmbulanceId?.driverId;
      return {
        ...r,
        driver: dId ? driversMap[String(dId)] || null : null,
        responseTimeMinutes:
          r.completionTime && r.requestTime
            ? Math.round((new Date(r.completionTime) - new Date(r.requestTime)) / 60_000)
            : null,
      };
    });

    res.status(200).json({
      success: true,
      count:   enhanced.length,
      total,
      page:    pageNum,
      pages:   Math.ceil(total / limitNum),
      data:    enhanced,
    });
  } catch (err) {
    next(err);
  }
};

// ─── GET /api/emergency/:id ───────────────────────────────────────────────────

/**
 * @desc  Get single emergency request by ID
 * @route GET /api/emergency/:id
 * @access Private (related parties only)
 */
exports.getEmergencyRequest = async (req, res, next) => {
  try {
    const request = await EmergencyRequest.findById(req.params.id)
      .populate('userId', 'name email phone')
      .populate('assignedAmbulanceId', 'plateNumber driverId status')
      .populate('assignedHospital', 'name email phone')
      .lean({ virtuals: false }); // Use lean for performance

    if (!request) throw new AppError('Emergency request not found', 404);

    const isAuthorised =
      req.user.role === ROLES.ADMIN ||
      req.user.role === ROLES.DISPATCHER ||
      String(request.userId?._id) === String(req.user._id) ||
      String(request.assignedHospital?._id) === String(req.user._id) ||
      (request.assignedAmbulanceId &&
        String(request.assignedAmbulanceId.driverId) === String(req.user._id));

    if (!isAuthorised) throw new AppError('Not authorised to view this request', 403);

    // FIX: DispatchLog was previously used without being imported
    const dispatchLog = await DispatchLog.findOne({ requestId: request._id })
      .select('attempts result createdAt')
      .lean();

    res.status(200).json({
      success: true,
      data: { ...request, dispatchLog: dispatchLog || null },
    });
  } catch (err) {
    next(err);
  }
};

// ─── PUT /api/emergency/:id/accept ───────────────────────────────────────────

/**
 * @desc  Hospital accepts an emergency request
 * @route PUT /api/emergency/:id/accept
 * @access Private (Hospital)
 */
exports.acceptEmergencyRequest = async (req, res, next) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const emergencyRequest = await EmergencyRequest.findById(req.params.id).session(session);

    if (!emergencyRequest) throw new AppError('Emergency request not found', 404);

    if (emergencyRequest.status !== REQUEST_STATUS.PENDING) {
      throw new AppError('This request has already been processed', 400);
    }

    emergencyRequest.status          = REQUEST_STATUS.ASSIGNED; // FIX: was ACCEPTED which doesn't exist in enum
    emergencyRequest.assignedHospital = req.user._id;
    await emergencyRequest.save({ session });

    await session.commitTransaction();

    const io = req.app.get('io');
    if (io) {
      io.to(`request_${emergencyRequest._id}`).emit('hospitalAccepted', {
        requestId:    emergencyRequest._id,
        hospitalId:   req.user._id,
        hospitalName: req.user.name,
      });
      io.to(`user_${emergencyRequest.userId}`).emit('requestAccepted', {
        requestId:    emergencyRequest._id,
        hospitalName: req.user.name,
      });
    }

    res.status(200).json({ success: true, data: emergencyRequest });
  } catch (err) {
    await session.abortTransaction();
    next(err);
  } finally {
    session.endSession();
  }
};

// ─── PUT /api/emergency/:id/complete ─────────────────────────────────────────

/**
 * @desc  Driver marks request as completed
 * @route PUT /api/emergency/:id/complete
 * @access Private (Driver)
 */
exports.completeEmergencyRequest = async (req, res, next) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const emergencyRequest = await EmergencyRequest.findById(req.params.id).session(session);

    if (!emergencyRequest)                               throw new AppError('Emergency request not found', 404);
    if (emergencyRequest.status !== REQUEST_STATUS.EN_ROUTE) throw new AppError('Request must be EN_ROUTE to complete', 400);

    const myAmb = await Ambulance.findOne({ driverId: req.user._id }).session(session);
    if (!myAmb || String(emergencyRequest.assignedAmbulanceId) !== String(myAmb._id)) {
      throw new AppError('Not authorised to complete this request', 403);
    }

    emergencyRequest.status         = REQUEST_STATUS.COMPLETED;
    emergencyRequest.completionTime = new Date();
    await emergencyRequest.save({ session });

    myAmb.status = AMBULANCE_STATUS.AVAILABLE;
    await myAmb.save({ session });

    await DispatchLog.findOneAndUpdate(
      { requestId: emergencyRequest._id },
      {
        $push: { logs: { message: 'Request completed by driver' } },
        completedAt: new Date(),
        status:      'COMPLETED',
      },
      { session, upsert: true }
    );

    await session.commitTransaction();

    const io = req.app.get('io');
    if (io) {
      io.to(`request_${emergencyRequest._id}`).emit('requestCompleted', {
        requestId:      emergencyRequest._id,
        completionTime: emergencyRequest.completionTime,
      });
      io.to(`user_${emergencyRequest.userId}`).emit('emergencyCompleted', {
        requestId: emergencyRequest._id,
        message:   'Your emergency request has been completed',
      });
      io.to('admins').emit('requestCompleted', {
        requestId:   emergencyRequest._id,
        ambulanceId: myAmb._id,
      });
    }

    res.status(200).json({ success: true, data: emergencyRequest });
  } catch (err) {
    await session.abortTransaction();
    next(err);
  } finally {
    session.endSession();
  }
};

// ─── GET /api/emergency/history ───────────────────────────────────────────────

/**
 * @desc  Get request history for current citizen user
 * @route GET /api/emergency/history
 * @access Private (Citizen)
 */
exports.getRequestHistory = async (req, res, next) => {
  try {
    const pageNum  = Math.max(1, parseInt(req.query.page, 10)  || 1);
    const limitNum = Math.min(100, parseInt(req.query.limit, 10) || 20);
    const skip     = (pageNum - 1) * limitNum;

    const [requests, total] = await Promise.all([
      EmergencyRequest.find({ userId: req.user._id })
        .populate('assignedAmbulanceId', 'plateNumber')
        .populate('assignedHospital',    'name')
        .sort('-requestTime')
        .skip(skip)
        .limit(limitNum)
        .lean(),
      EmergencyRequest.countDocuments({ userId: req.user._id }),
    ]);

    // FIX: `req` shadowed the outer `req` variable in the original `.map(req => ...)`
    const enhanced = requests.map((r) => ({
      ...r,
      responseTimeMinutes:
        r.completionTime && r.requestTime
          ? Math.round((new Date(r.completionTime) - new Date(r.requestTime)) / 60_000)
          : null,
    }));

    res.status(200).json({
      success: true,
      count:   enhanced.length,
      total,
      page:    pageNum,
      pages:   Math.ceil(total / limitNum),
      data:    enhanced,
    });
  } catch (err) {
    next(err);
  }
};

// ─── POST /api/emergency — forward to dispatch ───────────────────────────────

/**
 * @desc  Create emergency SOS request (delegates to dispatchController)
 * @route POST /api/emergency
 * @access Private (Citizen)
 */
exports.createEmergencyRequest = (req, res, next) => {
  // Lazy require to avoid circular dependency at load time
  const dispatchController = require('./dispatchController');
  return dispatchController.newRequest(req, res, next);
};
