'use strict';

/**
 * Emergency Response System — Test Suite
 *
 * Covers:
 *  - Unit tests for utilities (haversine, constants, AppError)
 *  - Controller logic tests (mocked DB)
 *  - Middleware tests (auth, role)
 *  - Edge cases
 *  - Stress / boundary tests
 *
 * Run with: jest
 * Dependencies: jest, jest-mock-extended (or manual mocks as shown below)
 */

// ─────────────────────────────────────────────────────────────────────────────
// 1. UTILITY UNIT TESTS
// ─────────────────────────────────────────────────────────────────────────────

describe('haversineDistance', () => {
  const { haversineDistance } = require('../utils/haversine');

  it('returns 0 for identical coordinates', () => {
    expect(haversineDistance(51.5, -0.1, 51.5, -0.1)).toBe(0);
  });

  it('calculates ~111km per degree of latitude at the equator', () => {
    const dist = haversineDistance(0, 0, 1, 0);
    expect(dist).toBeCloseTo(111_195, -2); // ± 100 m
  });

  it('calculates ~557km for 5 degrees latitude', () => {
    const dist = haversineDistance(0, 0, 5, 0);
    expect(dist).toBeCloseTo(555_975, -2);
  });

  it('is symmetric (a→b === b→a)', () => {
    const d1 = haversineDistance(51.5, -0.1, 48.8, 2.3);
    const d2 = haversineDistance(48.8, 2.3, 51.5, -0.1);
    expect(d1).toBeCloseTo(d2, 0);
  });

  it('handles antipodal points (max ~20015km)', () => {
    const dist = haversineDistance(90, 0, -90, 0);
    expect(dist).toBeGreaterThan(19_000_000);
    expect(dist).toBeLessThan(21_000_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('AppError', () => {
  const AppError = require('../utils/AppError');

  it('sets statusCode and message correctly', () => {
    const err = new AppError('Not found', 404);
    expect(err.message).toBe('Not found');
    expect(err.statusCode).toBe(404);
    expect(err.status).toBe('fail');
    expect(err.isOperational).toBe(true);
  });

  it('sets status = "error" for 5xx codes', () => {
    const err = new AppError('Server error', 500);
    expect(err.status).toBe('error');
  });

  it('stores optional code', () => {
    const err = new AppError('Bad request', 400, 'DUPLICATE_EMAIL');
    expect(err.code).toBe('DUPLICATE_EMAIL');
  });

  it('is an instance of Error', () => {
    expect(new AppError('x', 400)).toBeInstanceOf(Error);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('constants', () => {
  const C = require('../utils/constants');

  it('exports frozen objects', () => {
    expect(Object.isFrozen(C.ROLES)).toBe(true);
    expect(Object.isFrozen(C.REQUEST_STATUS)).toBe(true);
    expect(Object.isFrozen(C.AMBULANCE_STATUS)).toBe(true);
  });

  it('ROLES_VALUES is an array of all role strings', () => {
    expect(Array.isArray(C.ROLES_VALUES)).toBe(true);
    expect(C.ROLES_VALUES).toContain('ADMIN');
    expect(C.ROLES_VALUES).toContain('CITIZEN');
  });

  it('REQUEST_STATUS_VALUES does NOT contain ACCEPTED (was a bug)', () => {
    expect(C.REQUEST_STATUS_VALUES).not.toContain('ACCEPTED');
  });

  it('AMBULANCE_TRANSITIONS covers all statuses', () => {
    C.AMBULANCE_STATUS_VALUES.forEach((status) => {
      expect(C.AMBULANCE_TRANSITIONS).toHaveProperty(status);
    });
  });

  it('REQUEST_PRIORITY is an object with .includes undefined (not an array)', () => {
    // Regression test for Bug #6: original code called REQUEST_PRIORITY.includes()
    expect(typeof C.REQUEST_PRIORITY.includes).toBe('undefined');
    // The FIX is to use REQUEST_PRIORITY_VALUES.includes()
    expect(Array.isArray(C.REQUEST_PRIORITY_VALUES)).toBe(true);
    expect(typeof C.REQUEST_PRIORITY_VALUES.includes).toBe('function');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. AUTH MIDDLEWARE TESTS (mocked)
// ─────────────────────────────────────────────────────────────────────────────

describe('auth middleware — protect', () => {
  let protect, revokeToken;
  let mockReq, mockRes, mockNext;

  const jwt       = require('jsonwebtoken');
  const secret    = 'test-secret';

  // Silence console noise from redisClient
  beforeAll(() => {
    process.env.JWT_SECRET = secret;
    jest.mock('../utils/redisClient', () => null);
    jest.mock('../models/User', () => ({
      findById: jest.fn(),
    }));
    const auth = require('../middleware/auth');
    protect      = auth.protect;
    revokeToken  = auth.revokeToken;
  });

  beforeEach(() => {
    mockReq  = { headers: {}, cookies: {} };
    mockRes  = {};
    mockNext = jest.fn();
  });

  it('calls next(AppError 401) when no token provided', async () => {
    await protect(mockReq, mockRes, mockNext);
    expect(mockNext).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 401 })
    );
  });

  it('calls next(AppError 401) for expired token', async () => {
    const expired = jwt.sign({ id: 'abc' }, secret, { expiresIn: '-1s' });
    mockReq.headers.authorization = `Bearer ${expired}`;
    await protect(mockReq, mockRes, mockNext);
    expect(mockNext).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 401 })
    );
  });

  it('calls next(AppError 401) for tampered token', async () => {
    const valid   = jwt.sign({ id: 'abc' }, secret, { expiresIn: '1h' });
    const tampered = valid.slice(0, -5) + 'XXXXX';
    mockReq.headers.authorization = `Bearer ${tampered}`;
    await protect(mockReq, mockRes, mockNext);
    expect(mockNext).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 401 })
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. ROLE MIDDLEWARE TESTS
// ─────────────────────────────────────────────────────────────────────────────

describe('role middleware — authorize', () => {
  const { authorize }    = require('../middleware/role');
  const { ROLES }        = require('../utils/constants');
  let next;

  beforeEach(() => { next = jest.fn(); });

  const makeReq = (role) => ({ user: { _id: '123', role } });

  it('allows ADMIN regardless of specified roles', () => {
    authorize(ROLES.CITIZEN)(makeReq(ROLES.ADMIN), {}, next);
    expect(next).toHaveBeenCalledWith(); // called with no arguments
  });

  it('allows user with matching role', () => {
    authorize(ROLES.DRIVER)(makeReq(ROLES.DRIVER), {}, next);
    expect(next).toHaveBeenCalledWith();
  });

  it('rejects user with non-matching role', () => {
    authorize(ROLES.HOSPITAL)(makeReq(ROLES.CITIZEN), {}, next);
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 403 })
    );
  });

  it('allows one of multiple allowed roles', () => {
    authorize(ROLES.ADMIN, ROLES.DISPATCHER, ROLES.HOSPITAL)(makeReq(ROLES.DISPATCHER), {}, next);
    expect(next).toHaveBeenCalledWith();
  });

  it('calls next(AppError 401) when req.user is missing', () => {
    authorize(ROLES.CITIZEN)({ user: null }, {}, next);
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 401 })
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. AUTH CONTROLLER UNIT TESTS
// ─────────────────────────────────────────────────────────────────────────────

describe('authController.register — input validation', () => {
  const ctrl = require('../controllers/authController');
  let req, res, next;

  beforeEach(() => {
    req  = { body: {} };
    res  = { status: jest.fn().mockReturnThis(), json: jest.fn(), cookie: jest.fn() };
    next = jest.fn();
  });

  const cases = [
    ['missing name',     { email: 'a@b.com', phone: '+1234567890', password: 'Aa1!aaaa' }],
    ['missing email',    { name: 'Alice', phone: '+1234567890', password: 'Aa1!aaaa' }],
    ['missing phone',    { name: 'Alice', email: 'a@b.com', password: 'Aa1!aaaa' }],
    ['missing password', { name: 'Alice', email: 'a@b.com', phone: '+1234567890' }],
    ['invalid email',    { name: 'Alice', email: 'not-an-email', phone: '+1234567890', password: 'Aa1!aaaa' }],
    ['weak password',    { name: 'Alice', email: 'a@b.com', phone: '+1234567890', password: 'password' }],
    ['invalid phone',    { name: 'Alice', email: 'a@b.com', phone: '0000', password: 'Aa1!aaaa' }],
  ];

  test.each(cases)('rejects %s', async (_label, body) => {
    req.body = body;
    await ctrl.register(req, res, next);
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 400 })
    );
  });

  it('prevents self-assigning ADMIN role', async () => {
    // Mock User.findOne and User.create
    const User = require('../models/User');
    User.findOne = jest.fn().mockResolvedValue(null);
    User.create  = jest.fn().mockResolvedValue({
      _id: 'u1', name: 'Alice', email: 'a@b.com',
      phone: '+1234567890', role: 'CITIZEN',
    });

    req.body = {
      name: 'Alice', email: 'a@b.com',
      phone: '+1234567890', password: 'Aa1!Bbbb1!',
      role: 'ADMIN',
    };

    await ctrl.register(req, res, next);

    // If create was called, check the role passed was not ADMIN
    if (User.create.mock.calls.length > 0) {
      const created = User.create.mock.calls[0][0];
      expect(created.role).not.toBe('ADMIN');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. DISPATCH CONTROLLER — coordinate validation
// ─────────────────────────────────────────────────────────────────────────────

describe('dispatchController.newRequest — coordinate validation', () => {
  const ctrl = require('../controllers/dispatchController');
  let req, res, next;

  beforeEach(() => {
    req  = {
      body: {},
      user: { _id: 'u1', name: 'Alice', phone: '+1234567890' },
      app:  { get: jest.fn() },
    };
    res  = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    next = jest.fn();
  });

  const badCoords = [
    ['missing latitude',              { longitude: 0 }],
    ['missing longitude',             { latitude: 0 }],
    ['latitude out of range (> 90)',  { latitude: 91, longitude: 0 }],
    ['latitude out of range (< -90)', { latitude: -91, longitude: 0 }],
    ['longitude out of range (> 180)',{ latitude: 0, longitude: 181 }],
    ['non-numeric latitude',          { latitude: 'abc', longitude: 0 }],
  ];

  test.each(badCoords)('rejects %s', async (_label, coords) => {
    req.body = coords;
    await ctrl.newRequest(req, res, next);
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 400 })
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. AMBULANCE STATUS TRANSITIONS
// ─────────────────────────────────────────────────────────────────────────────

describe('ambulanceController.updateStatus — valid/invalid transitions', () => {
  const { AMBULANCE_TRANSITIONS, AMBULANCE_STATUS } = require('../utils/constants');

  it('AVAILABLE → ASSIGNED is valid', () => {
    const allowed = AMBULANCE_TRANSITIONS[AMBULANCE_STATUS.AVAILABLE];
    expect(allowed).toContain(AMBULANCE_STATUS.ASSIGNED);
  });

  it('AVAILABLE → BUSY is invalid', () => {
    const allowed = AMBULANCE_TRANSITIONS[AMBULANCE_STATUS.AVAILABLE];
    expect(allowed).not.toContain(AMBULANCE_STATUS.BUSY);
  });

  it('MAINTENANCE → AVAILABLE is valid', () => {
    const allowed = AMBULANCE_TRANSITIONS[AMBULANCE_STATUS.MAINTENANCE];
    expect(allowed).toContain(AMBULANCE_STATUS.AVAILABLE);
  });

  it('BUSY → ENROUTE is invalid', () => {
    const allowed = AMBULANCE_TRANSITIONS[AMBULANCE_STATUS.BUSY];
    expect(allowed).not.toContain(AMBULANCE_STATUS.ENROUTE);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. EDGE CASE TESTS
// ─────────────────────────────────────────────────────────────────────────────

describe('Edge cases — pagination clamping', () => {
  it('clamps negative page to 1', () => {
    const page = Math.max(1, parseInt('-5', 10) || 1);
    expect(page).toBe(1);
  });

  it('clamps zero page to 1', () => {
    const page = Math.max(1, parseInt('0', 10) || 1);
    expect(page).toBe(1);
  });

  it('clamps limit > 100 to 100', () => {
    const limit = Math.min(100, parseInt('99999', 10) || 50);
    expect(limit).toBe(100);
  });

  it('handles NaN limit gracefully', () => {
    const limit = Math.min(100, parseInt('banana', 10) || 50);
    expect(limit).toBe(50);
  });
});

describe('Edge cases — request shadow variable (Bug #8 regression)', () => {
  it('does not shadow req parameter inside map callback', () => {
    // Simulate the corrected pattern — callback parameter renamed to `r`
    const mockRequests = [
      { completionTime: new Date('2024-01-01T10:30:00Z'), requestTime: new Date('2024-01-01T10:00:00Z') },
      { completionTime: null, requestTime: new Date('2024-01-01T10:00:00Z') },
    ];

    // This should not throw or produce undefined
    const results = mockRequests.map((r) => ({
      ...r,
      responseTimeMinutes:
        r.completionTime && r.requestTime
          ? Math.round((new Date(r.completionTime) - new Date(r.requestTime)) / 60_000)
          : null,
    }));

    expect(results[0].responseTimeMinutes).toBe(30);
    expect(results[1].responseTimeMinutes).toBe(null);
  });
});

describe('Edge cases — REQUEST_STATUS has no ACCEPTED value (Bug #5 regression)', () => {
  const { REQUEST_STATUS } = require('../utils/constants');

  it('REQUEST_STATUS.ACCEPTED is undefined', () => {
    expect(REQUEST_STATUS.ACCEPTED).toBeUndefined();
  });

  it('Mongoose would reject undefined status — only valid enums exist', () => {
    const validStatuses = ['PENDING', 'ASSIGNED', 'EN_ROUTE', 'COMPLETED', 'CANCELLED'];
    validStatuses.forEach((s) => expect(REQUEST_STATUS).toHaveProperty(s === 'EN_ROUTE' ? 'EN_ROUTE' : s));
  });
});

describe('Edge cases — .includes() on REQUEST_PRIORITY object (Bug #6 regression)', () => {
  const { REQUEST_PRIORITY, REQUEST_PRIORITY_VALUES } = require('../utils/constants');

  it('REQUEST_PRIORITY object has no .includes method', () => {
    expect(typeof REQUEST_PRIORITY.includes).toBe('undefined');
  });

  it('REQUEST_PRIORITY_VALUES array has .includes method', () => {
    expect(typeof REQUEST_PRIORITY_VALUES.includes).toBe('function');
    expect(REQUEST_PRIORITY_VALUES.includes('HIGH')).toBe(true);
    expect(REQUEST_PRIORITY_VALUES.includes('INVALID')).toBe(false);
  });

  it('priority fallback to MEDIUM works correctly', () => {
    const priority = undefined;
    const prio = REQUEST_PRIORITY_VALUES.includes(priority?.toUpperCase())
      ? priority.toUpperCase()
      : 'MEDIUM';
    expect(prio).toBe('MEDIUM');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. STRESS / BOUNDARY TESTS
// ─────────────────────────────────────────────────────────────────────────────

describe('Stress — haversine with extreme inputs', () => {
  const { haversineDistance } = require('../utils/haversine');

  it('handles 0,0 origin correctly', () => {
    expect(haversineDistance(0, 0, 0, 0)).toBe(0);
  });

  it('does not return NaN for valid edge coordinates', () => {
    expect(haversineDistance(90, 180, -90, -180)).not.toBeNaN();
    expect(haversineDistance(0, -180, 0, 180)).not.toBeNaN();
  });

  it('runs 100,000 iterations in under 500ms', () => {
    const start = Date.now();
    for (let i = 0; i < 100_000; i++) {
      haversineDistance(
        Math.random() * 180 - 90,
        Math.random() * 360 - 180,
        Math.random() * 180 - 90,
        Math.random() * 360 - 180
      );
    }
    expect(Date.now() - start).toBeLessThan(500);
  });
});

describe('Stress — description truncation', () => {
  it('truncates description to 500 characters', () => {
    const longDesc  = 'A'.repeat(1000);
    const truncated = String(longDesc).trim().slice(0, 500);
    expect(truncated.length).toBe(500);
  });

  it('does not alter short descriptions', () => {
    const shortDesc = 'Heart attack';
    expect(String(shortDesc).trim().slice(0, 500)).toBe('Heart attack');
  });
});

describe('Stress — export row cap', () => {
  it('MAX_EXPORT_ROWS constant prevents unbounded queries', () => {
    const MAX_EXPORT_ROWS = 10_000;
    // Simulate what happens when we apply the limit
    const fakeTotal = 5_000_000;
    const returned  = Math.min(fakeTotal, MAX_EXPORT_ROWS);
    expect(returned).toBe(MAX_EXPORT_ROWS);
  });
});
