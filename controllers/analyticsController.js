'use strict';

const EmergencyRequest = require('../models/EmergencyRequest');
const Ambulance        = require('../models/Ambulance');
const User             = require('../models/User');
const AppError         = require('../utils/AppError');

const VALID_GROUP_BY   = ['hour', 'day', 'week', 'month'];
const MAX_EXPORT_ROWS  = 10_000; // FIX: prevent unbounded full-table export (DoS / OOM)

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a MongoDB $group _id spec and sort spec for the requested grouping.
 * @param {string} groupBy
 * @returns {{ groupId: object|null, sort: object }}
 */
const buildGroupSpec = (groupBy) => {
  switch (groupBy) {
    case 'hour':
      return {
        groupId: {
          year:  { $year: '$requestTime' },
          month: { $month: '$requestTime' },
          day:   { $dayOfMonth: '$requestTime' },
          hour:  { $hour: '$requestTime' },
        },
        sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1, '_id.hour': 1 },
      };
    case 'day':
      return {
        groupId: {
          year:  { $year: '$requestTime' },
          month: { $month: '$requestTime' },
          day:   { $dayOfMonth: '$requestTime' },
        },
        sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1 },
      };
    case 'week':
      return {
        groupId: {
          year: { $year: '$requestTime' },
          week: { $week: '$requestTime' },
        },
        sort: { '_id.year': 1, '_id.week': 1 },
      };
    case 'month':
      return {
        groupId: {
          year:  { $year: '$requestTime' },
          month: { $month: '$requestTime' },
        },
        sort: { '_id.year': 1, '_id.month': 1 },
      };
    default:
      return { groupId: null, sort: {} };
  }
};

// ─── GET /api/analytics/latency ───────────────────────────────────────────────

/**
 * @desc  Response-latency metrics with optional date range and time grouping
 * @route GET /api/analytics/latency
 * @access Private (Admin)
 */
exports.getLatencyMetrics = async (req, res, next) => {
  try {
    const { startDate, endDate, groupBy } = req.query;

    if (groupBy && !VALID_GROUP_BY.includes(groupBy)) {
      throw new AppError(`groupBy must be one of: ${VALID_GROUP_BY.join(', ')}`, 400);
    }

    const dateFilter = {};
    if (startDate || endDate) {
      dateFilter.requestTime = {};
      if (startDate) {
        const s = new Date(startDate);
        if (isNaN(s)) throw new AppError('Invalid startDate', 400);
        dateFilter.requestTime.$gte = s;
      }
      if (endDate) {
        const e = new Date(endDate);
        if (isNaN(e)) throw new AppError('Invalid endDate', 400);
        dateFilter.requestTime.$lte = e;
      }
    }

    const { groupId, sort } = buildGroupSpec(groupBy);

    // ── Main latency pipeline ──
    const pipeline = [
      {
        $match: {
          ...dateFilter,
          requestTime:    { $exists: true },
          allocationTime: { $exists: true },
          completionTime: { $exists: true },
        },
      },
      {
        $project: {
          responseLatency: {
            $divide: [{ $subtract: ['$allocationTime', '$requestTime'] }, 1000],
          },
          completionLatency: {
            $divide: [{ $subtract: ['$completionTime', '$allocationTime'] }, 1000],
          },
          totalLatency: {
            $divide: [{ $subtract: ['$completionTime', '$requestTime'] }, 1000],
          },
          requestTime: 1,
          priority:    1,
          type:        1,
        },
      },
    ];

    // FIX: $percentile requires MongoDB 7.0+. Use $sort + $group approximation
    // for broader compatibility; comment notes upgrade path.
    const groupAccumulators = {
      count:        { $sum: 1 },
      avgResponse:  { $avg: '$responseLatency' },
      minResponse:  { $min: '$responseLatency' },
      maxResponse:  { $max: '$responseLatency' },
      avgCompletion:{ $avg: '$completionLatency' },
      avgTotal:     { $avg: '$totalLatency' },
      // NOTE: upgrade to $percentile when MongoDB >= 7.0 is guaranteed
    };

    if (groupId) {
      pipeline.push({ $group: { _id: groupId, ...groupAccumulators } });
      pipeline.push({ $sort: sort });
    } else {
      pipeline.push({ $group: { _id: null, ...groupAccumulators } });
    }

    const result = await EmergencyRequest.aggregate(pipeline);

    // ── Priority breakdown (separate pipeline, reuses dateFilter) ──
    const priorityBreakdown = await EmergencyRequest.aggregate([
      { $match: { ...dateFilter, allocationTime: { $exists: true } } },
      {
        $group: {
          _id:         '$priority',
          count:       { $sum: 1 },
          avgResponse: {
            $avg: {
              $divide: [{ $subtract: ['$allocationTime', '$requestTime'] }, 1000],
            },
          },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    res.status(200).json({
      success: true,
      data: {
        metrics:    groupId ? result : (result[0] || {}),
        byPriority: priorityBreakdown,
        dateRange: {
          start: startDate || 'all time',
          end:   endDate   || 'present',
        },
      },
    });
  } catch (err) {
    next(err);
  }
};

// ─── GET /api/analytics/performance ──────────────────────────────────────────

/**
 * @desc  System-wide performance metrics for the last N days
 * @route GET /api/analytics/performance
 * @access Private (Admin)
 */
exports.getPerformanceMetrics = async (req, res, next) => {
  try {
    const days      = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 30));
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const [dailyMetrics, ambulanceUtilizationRaw, userActivityRaw] = await Promise.all([
      EmergencyRequest.aggregate([
        { $match: { requestTime: { $gte: startDate } } },
        {
          $group: {
            _id: {
              year:  { $year: '$requestTime' },
              month: { $month: '$requestTime' },
              day:   { $dayOfMonth: '$requestTime' },
            },
            totalRequests:     { $sum: 1 },
            completedRequests: {
              $sum: { $cond: [{ $eq: ['$status', 'COMPLETED'] }, 1, 0] },
            },
            // FIX: $and on two dates is not a valid $cond check — use $ifNull properly
            avgResponseSecs: {
              $avg: {
                $cond: [
                  {
                    $and: [
                      { $ifNull: ['$allocationTime', false] },
                      { $ifNull: ['$requestTime',    false] },
                    ],
                  },
                  { $divide: [{ $subtract: ['$allocationTime', '$requestTime'] }, 1000] },
                  null,
                ],
              },
            },
          },
        },
        { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1 } },
        { $limit: 365 },
      ]),

      Ambulance.aggregate([
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),

      User.aggregate([
        { $match: { createdAt: { $gte: startDate } } },
        { $group: { _id: '$role', newUsers: { $sum: 1 } } },
      ]),
    ]);

    const ambulanceUtilization = ambulanceUtilizationRaw.reduce(
      (acc, { _id, count }) => { acc[_id] = count; return acc; }, {}
    );
    const newUsers = userActivityRaw.reduce(
      (acc, { _id, newUsers: n }) => { acc[_id] = n; return acc; }, {}
    );

    res.status(200).json({
      success: true,
      data: {
        period: `${days} days`,
        daily:  dailyMetrics,
        ambulanceUtilization,
        newUsers,
      },
    });
  } catch (err) {
    next(err);
  }
};

// ─── GET /api/analytics/export ────────────────────────────────────────────────

/**
 * @desc  Export analytics data as JSON or CSV
 * @route GET /api/analytics/export
 * @access Private (Admin)
 *
 * FIX: Hard cap of MAX_EXPORT_ROWS to prevent OOM from full-table dumps.
 *      For larger exports, queue an async job and deliver via signed URL.
 */
exports.exportAnalytics = async (req, res, next) => {
  try {
    const { format = 'json', startDate, endDate } = req.query;

    if (!['json', 'csv'].includes(format)) {
      throw new AppError('format must be "json" or "csv"', 400);
    }

    const dateFilter = {};
    if (startDate || endDate) {
      dateFilter.requestTime = {};
      if (startDate) {
        const s = new Date(startDate);
        if (isNaN(s)) throw new AppError('Invalid startDate', 400);
        dateFilter.requestTime.$gte = s;
      }
      if (endDate) {
        const e = new Date(endDate);
        if (isNaN(e)) throw new AppError('Invalid endDate', 400);
        dateFilter.requestTime.$lte = e;
      }
    }

    const requests = await EmergencyRequest.find(dateFilter)
      .populate('userId',              'name email phone')
      .populate('assignedAmbulanceId', 'plateNumber')
      .sort('-requestTime')
      .limit(MAX_EXPORT_ROWS)
      .lean();

    if (format === 'csv') {
      const fields = [
        '_id', 'userName', 'userPhone', 'type', 'priority', 'status',
        'requestTime', 'allocationTime', 'completionTime',
      ];

      // FIX: ensure timestamp columns are not wrapped in quotes like other fields
      const rows = requests.map((r) =>
        fields
          .map((f) => {
            const val = r[f];
            if (val == null) return '';
            if (f.toLowerCase().includes('time') && val) {
              return new Date(val).toISOString();
            }
            // Escape double-quotes by doubling them (RFC 4180)
            return `"${String(val).replace(/"/g, '""')}"`;
          })
          .join(',')
      );

      const csv = [fields.join(','), ...rows].join('\n');

      res.setHeader('Content-Type',        'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="analytics-${Date.now()}.csv"`);
      return res.send(csv);
    }

    res.status(200).json({
      success:      true,
      count:        requests.length,
      truncated:    requests.length === MAX_EXPORT_ROWS,
      maxExportRows: MAX_EXPORT_ROWS,
      data:         requests,
    });
  } catch (err) {
    next(err);
  }
};
