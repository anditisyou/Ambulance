'use strict';

/**
 * Analytics & Admin Controller — Tests
 *
 * Covers: export row cap, date validation, pagination clamping,
 * role validation, self-delete / self-role-change protection.
 */

jest.mock('../utils/redisClient', () => null);
jest.mock('../models/EmergencyRequest', () => ({
  find:          jest.fn(),
  countDocuments: jest.fn(),
  aggregate:     jest.fn(),
}));
jest.mock('../models/Ambulance', () => ({
  find:          jest.fn(),
  countDocuments: jest.fn(),
  aggregate:     jest.fn(),
  deleteMany:    jest.fn(),
}));
jest.mock('../models/User', () => ({
  find:              jest.fn(),
  findById:          jest.fn(),
  findByIdAndUpdate: jest.fn(),
  findByIdAndDelete: jest.fn(),
  countDocuments:    jest.fn(),
  aggregate:         jest.fn(),
}));
jest.mock('../models/DispatchLog', () => ({}));
jest.mock('../models/MedicalRecord', () => ({ deleteMany: jest.fn() }));

const analyticsCtrl    = require('../controllers/analyticsController');
const adminCtrl        = require('../controllers/adminController');
const EmergencyRequest = require('../models/EmergencyRequest');
const Ambulance        = require('../models/Ambulance');
const User             = require('../models/User');

const makeRes = () => {
  const r = {};
  r.status  = jest.fn().mockReturnValue(r);
  r.json    = jest.fn().mockReturnValue(r);
  r.setHeader = jest.fn();
  r.send    = jest.fn().mockReturnValue(r);
  return r;
};

beforeEach(() => jest.clearAllMocks());

// ─────────────────────────────────────────────────────────────────────────────
// ANALYTICS — exportAnalytics row cap
// ─────────────────────────────────────────────────────────────────────────────

describe('analyticsController.exportAnalytics', () => {
  it('caps rows at MAX_EXPORT_ROWS (10,000) to prevent OOM', async () => {
    // Mock a find().populate().sort().limit().lean() chain
    const mockLean = jest.fn().mockResolvedValue(Array(100).fill({ _id: 'x', status: 'COMPLETED' }));
    const mockLimit = jest.fn().mockReturnValue({ lean: mockLean });
    const mockSort  = jest.fn().mockReturnValue({ limit: mockLimit });
    const mockPop2  = jest.fn().mockReturnValue({ sort: mockSort });
    const mockPop1  = jest.fn().mockReturnValue({ populate: mockPop2 });
    EmergencyRequest.find.mockReturnValue({ populate: mockPop1 });

    const req  = { query: { format: 'json' } };
    const res  = makeRes();
    const next = jest.fn();

    await analyticsCtrl.exportAnalytics(req, res, next);

    // Verify limit was called with 10_000
    expect(mockLimit).toHaveBeenCalledWith(10_000);
  });

  it('returns CSV with correct Content-Type header', async () => {
    const mockLean = jest.fn().mockResolvedValue([
      { _id: 'r1', userName: 'Alice', userPhone: '+1', type: 'MEDICAL',
        priority: 'HIGH', status: 'COMPLETED',
        requestTime: new Date('2024-01-01'), allocationTime: null, completionTime: null },
    ]);
    const mockLimit = jest.fn().mockReturnValue({ lean: mockLean });
    const mockSort  = jest.fn().mockReturnValue({ limit: mockLimit });
    const mockPop2  = jest.fn().mockReturnValue({ sort: mockSort });
    const mockPop1  = jest.fn().mockReturnValue({ populate: mockPop2 });
    EmergencyRequest.find.mockReturnValue({ populate: mockPop1 });

    const req  = { query: { format: 'csv' } };
    const res  = makeRes();
    const next = jest.fn();

    await analyticsCtrl.exportAnalytics(req, res, next);

    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Type',
      expect.stringContaining('text/csv')
    );
    expect(res.send).toHaveBeenCalled();
    // Ensure the CSV body is a string
    const csvBody = res.send.mock.calls[0][0];
    expect(typeof csvBody).toBe('string');
    expect(csvBody).toContain('_id'); // header row
  });

  it('rejects invalid format with 400', async () => {
    const req  = { query: { format: 'xml' } };
    const res  = makeRes();
    const next = jest.fn();
    await analyticsCtrl.exportAnalytics(req, res, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
  });

  it('rejects invalid startDate with 400', async () => {
    const req  = { query: { startDate: 'not-a-date' } };
    const res  = makeRes();
    const next = jest.fn();
    await analyticsCtrl.exportAnalytics(req, res, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
  });

  it('rejects invalid endDate with 400', async () => {
    const req  = { query: { endDate: 'not-a-date' } };
    const res  = makeRes();
    const next = jest.fn();
    await analyticsCtrl.exportAnalytics(req, res, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ANALYTICS — getLatencyMetrics groupBy validation
// ─────────────────────────────────────────────────────────────────────────────

describe('analyticsController.getLatencyMetrics', () => {
  beforeEach(() => {
    EmergencyRequest.aggregate.mockResolvedValue([]);
  });

  it('rejects invalid groupBy value', async () => {
    const req  = { query: { groupBy: 'decade' } };
    const res  = makeRes();
    const next = jest.fn();
    await analyticsCtrl.getLatencyMetrics(req, res, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
  });

  it('accepts valid groupBy values', async () => {
    for (const g of ['hour', 'day', 'week', 'month']) {
      EmergencyRequest.aggregate.mockResolvedValue([]);
      const req  = { query: { groupBy: g } };
      const res  = makeRes();
      const next = jest.fn();
      await analyticsCtrl.getLatencyMetrics(req, res, next);
      const errCalls = next.mock.calls.filter(c => c[0] && c[0].statusCode === 400);
      expect(errCalls.length).toBe(0);
    }
  });

  it('accepts no groupBy (overall stats)', async () => {
    EmergencyRequest.aggregate.mockResolvedValue([{ _id: null, count: 100, avgResponse: 45 }]);
    const req  = { query: {} };
    const res  = makeRes();
    const next = jest.fn();
    await analyticsCtrl.getLatencyMetrics(req, res, next);
    expect(next).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ANALYTICS — getPerformanceMetrics days parameter
// ─────────────────────────────────────────────────────────────────────────────

describe('analyticsController.getPerformanceMetrics', () => {
  beforeEach(() => {
    EmergencyRequest.aggregate.mockResolvedValue([]);
    Ambulance.aggregate.mockResolvedValue([]);
    User.aggregate.mockResolvedValue([]);
  });

  it('clamps days > 365 to 365', async () => {
    const req  = { query: { days: '9999' } };
    const res  = makeRes();
    const next = jest.fn();
    await analyticsCtrl.getPerformanceMetrics(req, res, next);
    // Check the response says 365 days
    const body = res.json.mock.calls[0]?.[0];
    expect(body?.data?.period).toBe('365 days');
  });

  it('defaults to 30 days', async () => {
    const req  = { query: {} };
    const res  = makeRes();
    const next = jest.fn();
    await analyticsCtrl.getPerformanceMetrics(req, res, next);
    const body = res.json.mock.calls[0]?.[0];
    expect(body?.data?.period).toBe('30 days');
  });

  it('minimum 1 day enforced', async () => {
    const req  = { query: { days: '0' } };
    const res  = makeRes();
    const next = jest.fn();
    await analyticsCtrl.getPerformanceMetrics(req, res, next);
    const body = res.json.mock.calls[0]?.[0];
    expect(body?.data?.period).toBe('1 days');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN — getAllUsers pagination
// ─────────────────────────────────────────────────────────────────────────────

describe('adminController.getAllUsers', () => {
  const setupUserMock = (users = [], total = 0) => {
    const lean  = jest.fn().mockResolvedValue(users);
    const limit = jest.fn().mockReturnValue({ lean });
    const skip  = jest.fn().mockReturnValue({ limit });
    const sort  = jest.fn().mockReturnValue({ skip });
    const select = jest.fn().mockReturnValue({ sort });
    User.find.mockReturnValue({ select });
    User.countDocuments.mockResolvedValue(total);
  };

  it('returns paginated users', async () => {
    setupUserMock([{ _id: 'u1', name: 'Alice', role: 'CITIZEN' }], 1);
    const req  = { query: {} };
    const res  = makeRes();
    await adminCtrl.getAllUsers(req, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it('clamps page to minimum 1', async () => {
    setupUserMock([], 0);
    const req  = { query: { page: '-5' } };
    const res  = makeRes();
    await adminCtrl.getAllUsers(req, res, jest.fn());
    // Should not throw — page clamped internally
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('rejects invalid role filter', async () => {
    const req  = { query: { role: 'SUPERADMIN' } };
    const res  = makeRes();
    const next = jest.fn();
    await adminCtrl.getAllUsers(req, res, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN — role change and delete protections
// ─────────────────────────────────────────────────────────────────────────────

describe('adminController.updateUserRole', () => {
  it('rejects changing own role', async () => {
    const req  = {
      params: { id: 'admin_1' },
      body:   { role: 'CITIZEN' },
      user:   { _id: 'admin_1' },
    };
    const res  = makeRes();
    const next = jest.fn();
    await adminCtrl.updateUserRole(req, res, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
  });

  it('rejects invalid role value', async () => {
    const req  = {
      params: { id: 'user_2' },
      body:   { role: 'OVERLORD' },
      user:   { _id: 'admin_1' },
    };
    const res  = makeRes();
    const next = jest.fn();
    await adminCtrl.updateUserRole(req, res, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
  });

  it('returns 404 when user not found', async () => {
    User.findByIdAndUpdate.mockResolvedValue(null);
    const req  = {
      params: { id: 'ghost_user' },
      body:   { role: 'DRIVER' },
      user:   { _id: 'admin_1' },
    };
    const res  = makeRes();
    const next = jest.fn();
    await adminCtrl.updateUserRole(req, res, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
  });
});

describe('adminController.deleteUser', () => {
  it('prevents admin from deleting themselves', async () => {
    const req  = {
      params: { id: 'admin_1' },
      user:   { _id: 'admin_1' },
    };
    const res  = makeRes();
    const next = jest.fn();
    await adminCtrl.deleteUser(req, res, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    // Ensure DB was NOT touched
    expect(User.findByIdAndDelete).not.toHaveBeenCalled();
  });

  it('returns 404 when target user not found', async () => {
    User.findByIdAndDelete.mockResolvedValue(null);
    const req  = {
      params: { id: 'ghost_user' },
      user:   { _id: 'admin_1' },
    };
    const res  = makeRes();
    const next = jest.fn();
    await adminCtrl.deleteUser(req, res, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN — getSystemStats uses constants (no hardcoded strings)
// ─────────────────────────────────────────────────────────────────────────────

describe('adminController.getSystemStats', () => {
  it('returns all stat keys', async () => {
    User.countDocuments.mockResolvedValue(100);
    Ambulance.countDocuments.mockResolvedValue(20);
    EmergencyRequest.countDocuments.mockResolvedValue(500);
    User.aggregate.mockResolvedValue([{ _id: 'CITIZEN', count: 80 }, { _id: 'DRIVER', count: 20 }]);

    const req  = { query: {} };
    const res  = makeRes();
    const next = jest.fn();
    await adminCtrl.getSystemStats(req, res, next);

    const body = res.json.mock.calls[0]?.[0];
    expect(body?.success).toBe(true);
    expect(body?.data).toHaveProperty('totalUsers');
    expect(body?.data).toHaveProperty('totalAmbulances');
    expect(body?.data).toHaveProperty('pendingRequests');
    expect(body?.data).toHaveProperty('roleDistribution');
  });
});
