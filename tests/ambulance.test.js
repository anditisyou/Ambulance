'use strict';

/**
 * Ambulance Controller & Model — Tests
 *
 * Covers status transitions, coordinate validation,
 * authorization rules, and haversine distance accuracy.
 */

jest.mock('../utils/redisClient', () => null);
jest.mock('../models/Ambulance', () => ({
  findOne:           jest.fn(),
  findById:          jest.fn(),
  findOneAndUpdate:  jest.fn(),
  find:              jest.fn(),
  countDocuments:    jest.fn(),
}));

const Ambulance      = require('../models/Ambulance');
const ambulanceCtrl  = require('../controllers/ambulanceController');
const {
  AMBULANCE_STATUS,
  AMBULANCE_STATUS_VALUES,
  AMBULANCE_TRANSITIONS,
} = require('../utils/constants');
const { haversineDistance } = require('../utils/haversine');

const makeRes = () => {
  const r = {};
  r.status  = jest.fn().mockReturnValue(r);
  r.json    = jest.fn().mockReturnValue(r);
  return r;
};

beforeEach(() => jest.clearAllMocks());

// ─────────────────────────────────────────────────────────────────────────────
// STATUS TRANSITION TABLE
// ─────────────────────────────────────────────────────────────────────────────

describe('AMBULANCE_TRANSITIONS — complete transition table', () => {
  const validTransitions = [
    [AMBULANCE_STATUS.AVAILABLE,   AMBULANCE_STATUS.ASSIGNED],
    [AMBULANCE_STATUS.AVAILABLE,   AMBULANCE_STATUS.MAINTENANCE],
    [AMBULANCE_STATUS.ASSIGNED,    AMBULANCE_STATUS.ENROUTE],
    [AMBULANCE_STATUS.ASSIGNED,    AMBULANCE_STATUS.AVAILABLE],
    [AMBULANCE_STATUS.ENROUTE,     AMBULANCE_STATUS.BUSY],
    [AMBULANCE_STATUS.ENROUTE,     AMBULANCE_STATUS.AVAILABLE],
    [AMBULANCE_STATUS.BUSY,        AMBULANCE_STATUS.AVAILABLE],
    [AMBULANCE_STATUS.MAINTENANCE, AMBULANCE_STATUS.AVAILABLE],
  ];

  const invalidTransitions = [
    [AMBULANCE_STATUS.AVAILABLE,   AMBULANCE_STATUS.BUSY],
    [AMBULANCE_STATUS.AVAILABLE,   AMBULANCE_STATUS.ENROUTE],
    [AMBULANCE_STATUS.BUSY,        AMBULANCE_STATUS.ASSIGNED],
    [AMBULANCE_STATUS.BUSY,        AMBULANCE_STATUS.ENROUTE],
    [AMBULANCE_STATUS.MAINTENANCE, AMBULANCE_STATUS.ASSIGNED],
    [AMBULANCE_STATUS.ENROUTE,     AMBULANCE_STATUS.MAINTENANCE],
  ];

  test.each(validTransitions)('%s → %s is VALID', (from, to) => {
    expect(AMBULANCE_TRANSITIONS[from]).toContain(to);
  });

  test.each(invalidTransitions)('%s → %s is INVALID', (from, to) => {
    expect(AMBULANCE_TRANSITIONS[from]).not.toContain(to);
  });

  it('every status has a defined transition entry', () => {
    AMBULANCE_STATUS_VALUES.forEach((s) => {
      expect(AMBULANCE_TRANSITIONS).toHaveProperty(s);
      expect(Array.isArray(AMBULANCE_TRANSITIONS[s])).toBe(true);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// updateStatus CONTROLLER
// ─────────────────────────────────────────────────────────────────────────────

describe('ambulanceController.updateStatus', () => {
  const mockAmb = (status = 'AVAILABLE', driverId = 'driver_1') => ({
    _id:      'amb_1',
    status,
    driverId,
    save:     jest.fn().mockResolvedValue(true),
  });

  it('allows valid transition AVAILABLE → ASSIGNED', async () => {
    Ambulance.findById.mockResolvedValue(mockAmb('AVAILABLE', 'driver_1'));
    const req = {
      params: { id: 'amb_1' },
      body:   { status: 'ASSIGNED' },
      user:   { _id: 'driver_1', role: 'DRIVER' },
      app:    { get: jest.fn().mockReturnValue(null) },
    };
    const res  = makeRes();
    const next = jest.fn();
    await ambulanceCtrl.updateStatus(req, res, next);
    expect(next).not.toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
  });

  it('rejects invalid transition AVAILABLE → BUSY with 400', async () => {
    Ambulance.findById.mockResolvedValue(mockAmb('AVAILABLE', 'driver_1'));
    const req = {
      params: { id: 'amb_1' },
      body:   { status: 'BUSY' },
      user:   { _id: 'driver_1', role: 'DRIVER' },
      app:    { get: jest.fn().mockReturnValue(null) },
    };
    const res  = makeRes();
    const next = jest.fn();
    await ambulanceCtrl.updateStatus(req, res, next);
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 400 })
    );
  });

  it('rejects update from non-owner driver with 403', async () => {
    Ambulance.findById.mockResolvedValue(mockAmb('AVAILABLE', 'driver_OTHER'));
    const req = {
      params: { id: 'amb_1' },
      body:   { status: 'ASSIGNED' },
      user:   { _id: 'driver_1', role: 'DRIVER' },
      app:    { get: jest.fn().mockReturnValue(null) },
    };
    const res  = makeRes();
    const next = jest.fn();
    await ambulanceCtrl.updateStatus(req, res, next);
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 403 })
    );
  });

  it('ADMIN can update any ambulance', async () => {
    Ambulance.findById.mockResolvedValue(mockAmb('AVAILABLE', 'driver_OTHER'));
    const req = {
      params: { id: 'amb_1' },
      body:   { status: 'MAINTENANCE' },
      user:   { _id: 'admin_1', role: 'ADMIN' },
      app:    { get: jest.fn().mockReturnValue(null) },
    };
    const res  = makeRes();
    const next = jest.fn();
    await ambulanceCtrl.updateStatus(req, res, next);
    expect(next).not.toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
  });

  it('returns 400 for unknown status value', async () => {
    Ambulance.findById.mockResolvedValue(mockAmb('AVAILABLE', 'driver_1'));
    const req = {
      params: { id: 'amb_1' },
      body:   { status: 'HYPERACTIVE' },
      user:   { _id: 'driver_1', role: 'DRIVER' },
      app:    { get: jest.fn().mockReturnValue(null) },
    };
    const res  = makeRes();
    const next = jest.fn();
    await ambulanceCtrl.updateStatus(req, res, next);
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 400 })
    );
  });

  it('returns 404 if ambulance not found', async () => {
    Ambulance.findById.mockResolvedValue(null);
    const req = {
      params: { id: 'nonexistent' },
      body:   { status: 'ASSIGNED' },
      user:   { _id: 'driver_1', role: 'DRIVER' },
      app:    { get: jest.fn().mockReturnValue(null) },
    };
    const res  = makeRes();
    const next = jest.fn();
    await ambulanceCtrl.updateStatus(req, res, next);
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 404 })
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// updateLocation CONTROLLER
// ─────────────────────────────────────────────────────────────────────────────

describe('ambulanceController.updateLocation', () => {
  const mockAmb = (coords = null, driverId = 'driver_1') => ({
    _id:             'amb_1',
    driverId,
    currentLocation: coords ? { type: 'Point', coordinates: coords } : null,
    save:            jest.fn().mockResolvedValue(true),
  });

  const baseReq = (body, driverId = 'driver_1') => ({
    params: { id: 'amb_1' },
    body,
    user: { _id: driverId },
    app:  { get: jest.fn().mockReturnValue({ to: jest.fn().mockReturnValue({ emit: jest.fn() }) }) },
  });

  it('rejects missing longitude', async () => {
    Ambulance.findById.mockResolvedValue(mockAmb());
    const next = jest.fn();
    await ambulanceCtrl.updateLocation(baseReq({ latitude: 51.5 }), makeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
  });

  it('rejects latitude > 90', async () => {
    Ambulance.findById.mockResolvedValue(mockAmb());
    const next = jest.fn();
    await ambulanceCtrl.updateLocation(baseReq({ latitude: 91, longitude: 0 }), makeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
  });

  it('skips save when ambulance has not moved > 50m', async () => {
    const amb = mockAmb([0.0, 51.5000]);
    Ambulance.findById.mockResolvedValue(amb);
    const next = jest.fn();
    const res  = makeRes();
    // 0.0001 degree lat ≈ 11 metres — under 50m threshold
    await ambulanceCtrl.updateLocation(
      baseReq({ latitude: 51.5001, longitude: 0.0 }),
      res,
      next
    );
    // save should NOT have been called
    expect(amb.save).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('50 m') })
    );
  });

  it('saves location when moved > 50m', async () => {
    const amb = mockAmb([0.0, 51.5000]);
    Ambulance.findById.mockResolvedValue(amb);
    const next = jest.fn();
    // 0.001 degree lat ≈ 111 metres — over 50m threshold
    await ambulanceCtrl.updateLocation(
      baseReq({ latitude: 51.501, longitude: 0.0 }),
      makeRes(),
      next
    );
    expect(amb.save).toHaveBeenCalled();
  });

  it('rejects location update from non-owner driver', async () => {
    Ambulance.findById.mockResolvedValue(mockAmb([0, 51.5], 'driver_OTHER'));
    const next = jest.fn();
    await ambulanceCtrl.updateLocation(
      baseReq({ latitude: 51.6, longitude: 0 }, 'driver_1'),
      makeRes(),
      next
    );
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HAVERSINE — 50m threshold accuracy
// ─────────────────────────────────────────────────────────────────────────────

describe('50m movement threshold accuracy', () => {
  it('11m move is below threshold', () => {
    // 0.0001° latitude ≈ 11.1m
    const d = haversineDistance(51.5000, 0.0, 51.5001, 0.0);
    expect(d).toBeLessThan(50);
  });

  it('111m move is above threshold', () => {
    // 0.001° latitude ≈ 111m
    const d = haversineDistance(51.5000, 0.0, 51.5010, 0.0);
    expect(d).toBeGreaterThan(50);
  });
});
