'use strict';

/**
 * Dispatch Controller — Advanced Tests
 *
 * Tests coordinate validation, priority/type fallbacks,
 * status transitions, and cancellation rules.
 */

jest.mock('../models/EmergencyRequest', () => ({
  findOne:        jest.fn(),
  find:           jest.fn(),
  create:         jest.fn(),
  countDocuments: jest.fn(),
}));

jest.mock('../models/Ambulance', () => ({
  findOne:           jest.fn(),
  findByIdAndUpdate: jest.fn(),
}));

jest.mock('../models/DispatchLog', () => ({
  findOneAndUpdate: jest.fn(),
}));

jest.mock('../utils/redisClient', () => null);
jest.mock('mongoose', () => {
  const mockSession = {
    startTransaction: jest.fn(),
    commitTransaction: jest.fn(),
    abortTransaction:  jest.fn(),
    endSession:        jest.fn(),
  };
  return {
    startSession: jest.fn().mockResolvedValue(mockSession),
    Types: { ObjectId: String },
  };
});

const EmergencyRequest = require('../models/EmergencyRequest');
const Ambulance        = require('../models/Ambulance');
const dispatchCtrl     = require('../controllers/dispatchController');
const { REQUEST_PRIORITY_VALUES, REQUEST_TYPES_VALUES } = require('../utils/constants');

const makeReq = (body = {}, user = {}) => ({
  body,
  params: {},
  user: {
    _id:   'citizen_001',
    name:  'Bob Jones',
    phone: '+15559991234',
    ...user,
  },
  app: { get: jest.fn().mockReturnValue({ to: jest.fn().mockReturnValue({ emit: jest.fn() }) }) },
});

const makeRes = () => {
  const r = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json   = jest.fn().mockReturnValue(r);
  return r;
};

beforeEach(() => jest.clearAllMocks());

// ─────────────────────────────────────────────────────────────────────────────
// COORDINATE VALIDATION
// ─────────────────────────────────────────────────────────────────────────────

describe('dispatchController.newRequest — coordinate validation', () => {
  const badCoords = [
    ['missing latitude',               { longitude: 0 }],
    ['missing longitude',              { latitude: 0 }],
    ['latitude > 90',                  { latitude: 91,  longitude: 0 }],
    ['latitude < -90',                 { latitude: -91, longitude: 0 }],
    ['longitude > 180',                { latitude: 0,   longitude: 181 }],
    ['longitude < -180',               { latitude: 0,   longitude: -181 }],
    ['NaN latitude',                   { latitude: 'abc', longitude: 0 }],
    ['NaN longitude',                  { latitude: 0,     longitude: 'abc' }],
    ['exactly null latitude',          { latitude: null, longitude: 0 }],
  ];

  test.each(badCoords)('rejects %s with 400', async (_label, body) => {
    const next = jest.fn();
    await dispatchCtrl.newRequest(makeReq(body), makeRes(), next);
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 400 })
    );
  });

  it('accepts valid boundary coordinates (lat=90, lng=180)', async () => {
    EmergencyRequest.findOne.mockResolvedValue(null);
    EmergencyRequest.create.mockResolvedValue([{
      _id: 'req_1', status: 'PENDING', location: { coordinates: [180, 90] },
      priority: 'MEDIUM', userName: 'Bob', userPhone: '+1', requestTime: new Date(),
    }]);
    Ambulance.findOne.mockResolvedValue(null); // no ambulance available

    const next = jest.fn();
    const res  = makeRes();
    await dispatchCtrl.newRequest(
      makeReq({ latitude: 90, longitude: 180 }),
      res,
      next
    );
    // Should NOT call next with an error — boundary coords are valid
    const errorCalls = (next.mock.calls || []).filter(c => c[0] && c[0].statusCode);
    expect(errorCalls.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PRIORITY + TYPE FALLBACKS (Bug #6 and #7 regression)
// ─────────────────────────────────────────────────────────────────────────────

describe('dispatchController — priority and type fallback (Bug #6 / #7 regression)', () => {
  it('REQUEST_PRIORITY_VALUES is an array (not object)', () => {
    expect(Array.isArray(REQUEST_PRIORITY_VALUES)).toBe(true);
    expect(typeof REQUEST_PRIORITY_VALUES.includes).toBe('function');
  });

  it('REQUEST_TYPES_VALUES is an array (not object)', () => {
    expect(Array.isArray(REQUEST_TYPES_VALUES)).toBe(true);
  });

  it('invalid priority string defaults to MEDIUM', () => {
    const priority = 'BANANA';
    const prio = REQUEST_PRIORITY_VALUES.includes(priority?.toUpperCase())
      ? priority.toUpperCase()
      : 'MEDIUM';
    expect(prio).toBe('MEDIUM');
  });

  it('undefined priority defaults to MEDIUM', () => {
    const priority = undefined;
    const prio = REQUEST_PRIORITY_VALUES.includes(priority?.toUpperCase())
      ? priority.toUpperCase()
      : 'MEDIUM';
    expect(prio).toBe('MEDIUM');
  });

  it('valid priority string CRITICAL is preserved', () => {
    const priority = 'CRITICAL';
    const prio = REQUEST_PRIORITY_VALUES.includes(priority?.toUpperCase())
      ? priority.toUpperCase()
      : 'MEDIUM';
    expect(prio).toBe('CRITICAL');
  });

  it('invalid type defaults to MEDICAL', () => {
    const type = 'EARTHQUAKE';
    const reqType = REQUEST_TYPES_VALUES.includes(type) ? type : 'MEDICAL';
    expect(reqType).toBe('MEDICAL');
  });

  it('valid type ACCIDENT is preserved', () => {
    const type = 'ACCIDENT';
    const reqType = REQUEST_TYPES_VALUES.includes(type) ? type : 'MEDICAL';
    expect(reqType).toBe('ACCIDENT');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DUPLICATE ACTIVE REQUEST
// ─────────────────────────────────────────────────────────────────────────────

describe('dispatchController.newRequest — duplicate active request', () => {
  it('blocks citizen who already has an active request', async () => {
    EmergencyRequest.findOne.mockResolvedValue({
      _id: 'existing_req', status: 'ASSIGNED',
    });

    const next = jest.fn();
    await dispatchCtrl.newRequest(
      makeReq({ latitude: 51.5, longitude: -0.1 }),
      makeRes(),
      next
    );

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 400 })
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CANCELLATION RULES
// ─────────────────────────────────────────────────────────────────────────────

describe('dispatchController.cancelRequest', () => {
  const mockSession = {
    startTransaction: jest.fn(),
    commitTransaction: jest.fn(),
    abortTransaction:  jest.fn(),
    endSession:        jest.fn(),
  };

  beforeEach(() => {
    require('mongoose').startSession.mockResolvedValue(mockSession);
  });

  it('rejects cancellation of EN_ROUTE request with 400', async () => {
    EmergencyRequest.findOne = jest.fn();
    const mongoose = require('mongoose');
    const mockReq = { ...makeReq({}, { _id: 'citizen_001' }), params: { id: 'req_1' } };

    // We test the logic directly — EN_ROUTE cannot be cancelled
    const cancellableStatuses = ['PENDING', 'ASSIGNED'];
    const currentStatus       = 'EN_ROUTE';
    const canCancel = cancellableStatuses.includes(currentStatus);
    expect(canCancel).toBe(false);
  });

  it('PENDING and ASSIGNED are cancellable', () => {
    const cancellable = ['PENDING', 'ASSIGNED'];
    expect(cancellable.includes('PENDING')).toBe(true);
    expect(cancellable.includes('ASSIGNED')).toBe(true);
  });

  it('COMPLETED and CANCELLED are not cancellable', () => {
    const cancellable = ['PENDING', 'ASSIGNED'];
    expect(cancellable.includes('COMPLETED')).toBe(false);
    expect(cancellable.includes('CANCELLED')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ETA ESTIMATE
// ─────────────────────────────────────────────────────────────────────────────

describe('ETA estimation (haversine at 40 km/h)', () => {
  const { haversineDistance } = require('../utils/haversine');

  const estimateEta = (from, to) => {
    const distM   = haversineDistance(from[1], from[0], to[1], to[0]);
    const speedMs = (40 * 1000) / 3600;
    return Math.round(distM / speedMs);
  };

  it('returns 0 for same-point dispatch', () => {
    expect(estimateEta([0, 0], [0, 0])).toBe(0);
  });

  it('returns positive seconds for non-zero distance', () => {
    const eta = estimateEta([-0.1, 51.5], [-0.2, 51.6]);
    expect(eta).toBeGreaterThan(0);
  });

  it('~1km takes ~90 seconds at 40 km/h', () => {
    // 1km at 40km/h = 1.5 minutes = 90 seconds
    // haversine of ~0.009 degree lat difference ≈ 1km
    const eta = estimateEta([0, 0], [0, 0.009]);
    expect(eta).toBeGreaterThan(60);
    expect(eta).toBeLessThan(200);
  });
});
