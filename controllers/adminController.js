'use strict';

const User             = require('../models/User');
const Ambulance        = require('../models/Ambulance');
const EmergencyRequest = require('../models/EmergencyRequest');
const AppError         = require('../utils/AppError');
const { ROLES, ROLES_VALUES, REQUEST_STATUS, AMBULANCE_STATUS_VALUES, SLA_TARGET_SECONDS } = require('../utils/constants');

// ─── GET /api/admin/users ─────────────────────────────────────────────────────

/**
 * @desc  Get all users with optional role filter, paginated
 * @route GET /api/admin/users
 * @access Private (Admin)
 */
exports.getAllUsers = async (req, res, next) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page,  10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip  = (page - 1) * limit;

    const query = {};
    if (req.query.role) {
      if (!ROLES_VALUES.includes(req.query.role)) {
        throw new AppError('Invalid role filter', 400);
      }
      query.role = req.query.role;
    }

    const [users, total] = await Promise.all([
      User.find(query)
        .select('name email phone role isActive createdAt')
        .sort('-createdAt')
        .skip(skip)
        .limit(limit)
        .lean(),
      User.countDocuments(query),
    ]);

    res.status(200).json({
      success: true,
      count:   users.length,
      total,
      page,
      pages:   Math.ceil(total / limit),
      data:    users,
    });
  } catch (err) {
    next(err);
  }
};

// ─── GET /api/admin/users/:id ─────────────────────────────────────────────────

/**
 * @desc  Get user by ID
 * @route GET /api/admin/users/:id
 * @access Private (Admin)
 */
exports.getUserById = async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id).select('-password').lean();
    if (!user) throw new AppError('User not found', 404);
    res.status(200).json({ success: true, data: user });
  } catch (err) {
    next(err);
  }
};

// ─── PUT /api/admin/users/:id/role ────────────────────────────────────────────

/**
 * @desc  Update user role
 * @route PUT /api/admin/users/:id/role
 * @access Private (Admin)
 */
exports.updateUserRole = async (req, res, next) => {
  try {
    const { role } = req.body;

    if (!ROLES_VALUES.includes(role)) {
      throw new AppError(`Invalid role. Must be one of: ${ROLES_VALUES.join(', ')}`, 400);
    }

    if (String(req.params.id) === String(req.user._id)) {
      throw new AppError('Cannot change your own role', 400);
    }

    const updateResult = User.findByIdAndUpdate(
      req.params.id,
      { role },
      { new: true, runValidators: true }
    );
    const user = updateResult && typeof updateResult.select === 'function'
      ? await updateResult.select('-password')
      : await updateResult;

    if (!user) throw new AppError('User not found', 404);

    res.status(200).json({ success: true, data: user });
  } catch (err) {
    next(err);
  }
};

// ─── DELETE /api/admin/users/:id ─────────────────────────────────────────────

/**
 * @desc  Delete user and cascade-delete associated data
 * @route DELETE /api/admin/users/:id
 * @access Private (Admin)
 *
 * NOTE: Consider soft-delete (isActive = false) in production to preserve
 * audit trails for completed emergency requests.
 */
exports.deleteUser = async (req, res, next) => {
  try {
    if (String(req.params.id) === String(req.user._id)) {
      throw new AppError('Cannot delete your own account', 400);
    }

    const user = await User.findByIdAndDelete(req.params.id);
    if (!user) throw new AppError('User not found', 404);

    // Cascade cleanup — run in parallel
    await Promise.all([
      Ambulance.deleteMany({ driverId: user._id }),
      EmergencyRequest.deleteMany({ userId: user._id }),
    ]);

    res.status(200).json({ success: true, message: 'User deleted successfully' });
  } catch (err) {
    next(err);
  }
};

// ─── GET /api/admin/ambulances ────────────────────────────────────────────────

/**
 * @desc  Get all ambulances with optional status filter, paginated
 * @route GET /api/admin/ambulances
 * @access Private (Admin)
 */
exports.getAllAmbulances = async (req, res, next) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page,  10) || 1);
    const limit = Math.min(100, parseInt(req.query.limit, 10) || 20);
    const skip  = (page - 1) * limit;

    const query = {};
    if (req.query.status) {
      if (!AMBULANCE_STATUS_VALUES.includes(req.query.status)) {
        throw new AppError('Invalid status filter', 400);
      }
      query.status = req.query.status;
    }

    const [ambulances, total] = await Promise.all([
      Ambulance.find(query)
        .populate('driverId', 'name email phone')
        .sort('-updatedAt')
        .skip(skip)
        .limit(limit)
        .lean(),
      Ambulance.countDocuments(query),
    ]);

    res.status(200).json({
      success: true,
      count:   ambulances.length,
      total,
      page,
      pages:   Math.ceil(total / limit),
      data:    ambulances,
    });
  } catch (err) {
    next(err);
  }
};

// ─── GET /api/admin/stats ─────────────────────────────────────────────────────

/**
 * @desc  Get real-time system statistics
 * @route GET /api/admin/stats
 * @access Private (Admin)
 */
exports.getSystemStats = async (req, res, next) => {
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    // FIX: use constants instead of hardcoded strings like 'PENDING', 'COMPLETED'
    const [
      totalUsers,
      totalAmbulances,
      totalRequests,
      pendingRequests,
      activeRequests,
      completedToday,
      roleDistributionRaw,
    ] = await Promise.all([
      User.countDocuments(),
      Ambulance.countDocuments(),
      EmergencyRequest.countDocuments(),
      EmergencyRequest.countDocuments({ status: REQUEST_STATUS.PENDING }),
      EmergencyRequest.countDocuments({
        status: { $in: [REQUEST_STATUS.ASSIGNED, REQUEST_STATUS.EN_ROUTE] },
      }),
      EmergencyRequest.countDocuments({
        status:         REQUEST_STATUS.COMPLETED,
        completionTime: { $gte: todayStart },
      }),
      User.aggregate([{ $group: { _id: '$role', count: { $sum: 1 } } }]),
    ]);

    const roleDistribution = roleDistributionRaw.reduce((acc, { _id, count }) => {
      acc[_id] = count;
      return acc;
    }, {});

    res.status(200).json({
      success: true,
      data: {
        totalUsers,
        totalAmbulances,
        totalRequests,
        pendingRequests,
        activeRequests,
        completedToday,
        roleDistribution,
      },
    });
  } catch (err) {
    next(err);
  }
};

// ─── GET /api/admin/dispatch-queue ───────────────────────────────────────────

/**
 * @desc  Get current dispatch queue and SLA risk summary
 * @route GET /api/admin/dispatch-queue
 * @access Private (Admin)
 */
exports.getDispatchQueue = async (req, res, next) => {
  try {
    const now = new Date();
    const pending = await EmergencyRequest.find({
      status: REQUEST_STATUS.PENDING,
    })
      .sort('requestTime')
      .limit(100)
      .lean();

    const queue = pending.map((request) => {
      const requestAgeSeconds = Math.max(0, (now - new Date(request.requestTime)) / 1000);
      const slaTarget = SLA_TARGET_SECONDS[request.priority] ?? SLA_TARGET_SECONDS.MEDIUM;
      const slaStatus = requestAgeSeconds > slaTarget
        ? 'BREACHED'
        : requestAgeSeconds > slaTarget * 0.75
          ? 'AT_RISK'
          : 'ON_TRACK';

      return {
        _id: request._id,
        userName: request.userName,
        userPhone: request.userPhone,
        priority: request.priority,
        requestTime: request.requestTime,
        queuedAt: request.requestTime,
        waitSeconds: Math.round(requestAgeSeconds),
        slaTargetSeconds: slaTarget,
        slaStatus,
        location: request.location?.coordinates,
        description: request.description,
      };
    });

    const breachedCount = queue.filter((item) => item.slaStatus === 'BREACHED').length;

    res.status(200).json({
      success: true,
      count: queue.length,
      data: queue,
      sla: {
        breachedCount,
        totalQueued: queue.length,
      },
    });
  } catch (err) {
    next(err);
  }
};
