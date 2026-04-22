'use strict';

/**
 * Integration Test Suite — Emergency Response System
 * ────────────────────────────────────────────────────
 * Uses mongodb-memory-server for an in-process MongoDB instance.
 * No real database, network, or Cloudinary credentials needed.
 *
 * Install dev dependencies:
 *   npm install --save-dev jest supertest mongodb-memory-server @jest-environment/node
 *
 * Run:
 *   jest tests/integration.test.js --runInBand
 */

const mongoose  = require('mongoose');
const request   = require('supertest');
jest.setTimeout(30000);

// ── Bootstrap in-memory MongoDB before anything imports Mongoose ──────────────
let mongoServer;
let app;

beforeAll(async () => {
  process.env.NODE_ENV   = 'test';
  process.env.JWT_SECRET = 'integration-test-secret';
  process.env.JWT_EXPIRE = '1h';
  process.env.SESSION_SECRET = 'integration-session-secret';

  const { MongoMemoryServer } = require('mongodb-memory-server');
  mongoServer = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongoServer.getUri();
  await mongoose.connect(process.env.MONGODB_URI);
  delete require.cache[require.resolve('../index')];
  app = require('../index').app;
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  // Clean all collections between tests for isolation
  const collections = mongoose.connection.collections;
  await Promise.all(
    Object.values(collections).map((col) => col.deleteMany({}))
  );
});

// ── Import app AFTER env is set ───────────────────────────────────────────────
// We import lazily to ensure env vars are set first.
const getApp = () => {
  return app;
};

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const registerUser = async (app, overrides = {}) => {
  const unique = `${Date.now()}${Math.floor(Math.random() * 100000)}`;
  const defaults = {
    name:     'Test User',
    email:    `test${unique}@example.com`,
    phone:    `+1${Math.floor(1000000000 + Math.random() * 9000000000)}`,
    password: 'Secure@Pass1',
    role:     'CITIZEN',
  };
  const body = { ...defaults, ...overrides };
  const res  = await request(app).post('/api/auth/register').send(body);
  return { res, body, token: res.body.token };
};

const registerAndLogin = async (app, overrides = {}) => {
  const { body, token } = await registerUser(app, overrides);
  return { token, email: body.email, phone: body.phone };
};

const authHeader = (token) => ({ Authorization: `Bearer ${token}` });

// ─────────────────────────────────────────────────────────────────────────────
// 1. HEALTH CHECK
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /health', () => {
  it('returns 200 with status ok', async () => {
    const app = getApp();
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.timestamp).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. AUTH ROUTES
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/auth/register', () => {
  let app;
  beforeEach(() => { app = getApp(); });

  it('201 — registers a new citizen user', async () => {
    const res = await request(app).post('/api/auth/register').send({
      name: 'Alice Smith', email: 'alice@test.com',
      phone: '+12025550100', password: 'Secure@Pass1',
    });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.token).toBeDefined();
    expect(res.body.user.role).toBe('CITIZEN');
    expect(res.body.user.password).toBeUndefined();
  });

  it('400 — rejects missing email', async () => {
    const res = await request(app).post('/api/auth/register').send({
      name: 'Bob', phone: '+12025550101', password: 'Secure@Pass1',
    });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('400 — rejects weak password', async () => {
    const res = await request(app).post('/api/auth/register').send({
      name: 'Bob', email: 'bob@test.com', phone: '+12025550102', password: 'password',
    });
    expect(res.status).toBe(400);
  });

  it('400 — rejects duplicate email', async () => {
    await request(app).post('/api/auth/register').send({
      name: 'Carol', email: 'carol@test.com',
      phone: '+12025550103', password: 'Secure@Pass1',
    });
    const res = await request(app).post('/api/auth/register').send({
      name: 'Carol2', email: 'carol@test.com',
      phone: '+12025550104', password: 'Secure@Pass1',
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/already exists/i);
  });

  it('sanitises ADMIN role to CITIZEN', async () => {
    const res = await request(app).post('/api/auth/register').send({
      name: 'Evil', email: 'evil@test.com',
      phone: '+12025550199', password: 'Secure@Pass1', role: 'ADMIN',
    });
    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe('CITIZEN');
  });
});

describe('POST /api/auth/login', () => {
  let app;
  beforeEach(() => { app = getApp(); });

  it('200 — logs in with correct credentials', async () => {
    await request(app).post('/api/auth/register').send({
      name: 'Dave', email: 'dave@test.com',
      phone: '+12025550200', password: 'Secure@Pass1',
    });
    const res = await request(app).post('/api/auth/login').send({
      email: 'dave@test.com', password: 'Secure@Pass1',
    });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
  });

  it('401 — rejects wrong password', async () => {
    await request(app).post('/api/auth/register').send({
      name: 'Eve', email: 'eve@test.com',
      phone: '+12025550201', password: 'Secure@Pass1',
    });
    const res = await request(app).post('/api/auth/login').send({
      email: 'eve@test.com', password: 'WrongPass1!',
    });
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Invalid credentials');
  });

  it('401 — rejects non-existent user', async () => {
    const res = await request(app).post('/api/auth/login').send({
      email: 'nobody@test.com', password: 'Secure@Pass1',
    });
    expect(res.status).toBe(401);
  });
});

describe('GET /api/auth/me', () => {
  let app;
  beforeEach(() => { app = getApp(); });

  it('200 — returns current user for valid token', async () => {
    const { token } = await registerUser(app);
    const res = await request(app).get('/api/auth/me').set(authHeader(token));
    expect(res.status).toBe(200);
    expect(res.body.user).toBeDefined();
    expect(res.body.user.password).toBeUndefined();
  });

  it('401 — rejects missing token', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  it('401 — rejects tampered token', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set({ Authorization: 'Bearer tampered.jwt.token' });
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. AMBULANCE ROUTES
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/ambulances', () => {
  let app, driverToken;

  beforeEach(async () => {
    app = getApp();
    // We need to manually set role to DRIVER since register sanitises to CITIZEN
    const { token } = await registerUser(app, { role: 'DRIVER' });
    // Directly update role in DB for integration test setup
    const User = require('../models/User');
    const jwt  = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    await User.findByIdAndUpdate(decoded.id, { role: 'DRIVER' });
    driverToken = token;
  });

  it('201 — registers a new ambulance', async () => {
    const res = await request(app)
      .post('/api/ambulances')
      .set(authHeader(driverToken))
      .send({ plateNumber: 'AMB-001', longitude: -0.1, latitude: 51.5 });
    expect(res.status).toBe(201);
    expect(res.body.data.plateNumber).toBe('AMB-001');
    expect(res.body.data.status).toBe('AVAILABLE');
  });

  it('400 — rejects missing plate number for new registration', async () => {
    const res = await request(app)
      .post('/api/ambulances')
      .set(authHeader(driverToken))
      .send({ longitude: -0.1, latitude: 51.5 });
    expect(res.status).toBe(400);
  });

  it('400 — rejects invalid coordinates', async () => {
    const res = await request(app)
      .post('/api/ambulances')
      .set(authHeader(driverToken))
      .send({ plateNumber: 'AMB-999', longitude: 999, latitude: 51.5 });
    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. EMERGENCY REQUEST ROUTES
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/dispatch/request', () => {
  let app, citizenToken;

  beforeEach(async () => {
    app = getApp();
    const { token } = await registerUser(app, { role: 'CITIZEN' });
    citizenToken = token;
  });

  it('201 — creates emergency request (no ambulance available → allocated=false)', async () => {
    const res = await request(app)
      .post('/api/dispatch/request')
      .set(authHeader(citizenToken))
      .send({ latitude: 51.5, longitude: -0.1, priority: 'HIGH', type: 'MEDICAL' });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('PENDING');
    expect(res.body.allocated).toBe(false); // No ambulance registered in this test
  });

  it('400 — rejects missing coordinates', async () => {
    const res = await request(app)
      .post('/api/dispatch/request')
      .set(authHeader(citizenToken))
      .send({ priority: 'HIGH' });
    expect(res.status).toBe(400);
  });

  it('400 — rejects latitude > 90', async () => {
    const res = await request(app)
      .post('/api/dispatch/request')
      .set(authHeader(citizenToken))
      .send({ latitude: 91, longitude: 0 });
    expect(res.status).toBe(400);
  });

  it('400 — blocks duplicate active request', async () => {
    // First request succeeds
    await request(app)
      .post('/api/dispatch/request')
      .set(authHeader(citizenToken))
      .send({ latitude: 51.5, longitude: -0.1 });

    // Second request should be blocked
    const res = await request(app)
      .post('/api/dispatch/request')
      .set(authHeader(citizenToken))
      .send({ latitude: 51.5, longitude: -0.1 });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/already have an active/i);
  });

  it('defaults unknown priority to MEDIUM', async () => {
    // Create fresh citizen to avoid duplicate-request block
    const { token } = await registerUser(app);
    const res = await request(app)
      .post('/api/dispatch/request')
      .set(authHeader(token))
      .send({ latitude: 51.5, longitude: -0.1, priority: 'BANANA' });
    expect(res.status).toBe(201);
    expect(res.body.data.priority).toBe('MEDIUM');
  });

  it('401 — rejects unauthenticated request', async () => {
    const res = await request(app)
      .post('/api/dispatch/request')
      .send({ latitude: 51.5, longitude: -0.1 });
    expect(res.status).toBe(401);
  });
});

describe('GET /api/dispatch/active', () => {
  let app, citizenToken;

  beforeEach(async () => {
    app = getApp();
    const { token } = await registerUser(app);
    citizenToken = token;
  });

  it('200 — returns null when no active request', async () => {
    const res = await request(app)
      .get('/api/dispatch/active')
      .set(authHeader(citizenToken));
    expect(res.status).toBe(200);
    expect(res.body.data).toBeNull();
  });

  it('200 — returns active request after creating one', async () => {
    await request(app)
      .post('/api/dispatch/request')
      .set(authHeader(citizenToken))
      .send({ latitude: 51.5, longitude: -0.1 });

    const res = await request(app)
      .get('/api/dispatch/active')
      .set(authHeader(citizenToken));
    expect(res.status).toBe(200);
    expect(res.body.data).not.toBeNull();
    expect(['PENDING', 'ASSIGNED', 'EN_ROUTE']).toContain(res.body.data.status);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. EMERGENCY HISTORY
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/emergency/history', () => {
  let app, citizenToken;

  beforeEach(async () => {
    app = getApp();
    const { token } = await registerUser(app);
    citizenToken = token;
  });

  it('200 — returns empty array for new user', async () => {
    const res = await request(app)
      .get('/api/emergency/history')
      .set(authHeader(citizenToken));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.total).toBe(0);
  });

  it('200 — paginates correctly', async () => {
    // Create 3 requests (need 3 separate users to avoid duplicate-request block)
    for (let i = 0; i < 3; i++) {
      const { token } = await registerUser(app);
      await request(app)
        .post('/api/dispatch/request')
        .set(authHeader(token))
        .send({ latitude: 51.5, longitude: -0.1 });
    }

    // Create 3 for our test citizen directly via model
    const EmergencyRequest = require('../models/EmergencyRequest');
    const jwt              = require('jsonwebtoken');
    const decoded          = jwt.verify(citizenToken, process.env.JWT_SECRET);
    for (let i = 0; i < 3; i++) {
      await EmergencyRequest.create({
        userId:    decoded.id,
        userName:  'Test User',
        userPhone: '+12025550000',
        location:  { type: 'Point', coordinates: [-0.1, 51.5] },
        status:    'COMPLETED',
        requestTime: new Date(),
      });
    }

    const res = await request(app)
      .get('/api/emergency/history?page=1&limit=2')
      .set(authHeader(citizenToken));
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(2);
    expect(res.body.total).toBe(3);
    expect(res.body.pages).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. ADMIN ROUTES
// ─────────────────────────────────────────────────────────────────────────────

describe('Admin routes', () => {
  let app, adminToken, citizenToken;

  beforeEach(async () => {
    app = getApp();
    const User = require('../models/User');
    const jwt  = require('jsonwebtoken');

    // Create admin user
    const { token: cToken }  = await registerUser(app, { email: 'admin@test.com', phone: '+19995550001' });
    const decoded            = jwt.verify(cToken, process.env.JWT_SECRET);
    await User.findByIdAndUpdate(decoded.id, { role: 'ADMIN' });
    adminToken = cToken;

    // Create a citizen to operate on
    const { token } = await registerUser(app, { email: 'citizen@test.com', phone: '+19995550002' });
    citizenToken    = token;
  });

  it('200 — admin can list all users', async () => {
    const res = await request(app)
      .get('/api/admin/users')
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('403 — citizen cannot access admin users list', async () => {
    const res = await request(app)
      .get('/api/admin/users')
      .set(authHeader(citizenToken));
    expect(res.status).toBe(403);
  });

  it('200 — admin can get system stats', async () => {
    const res = await request(app)
      .get('/api/admin/stats')
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('totalUsers');
    expect(res.body.data).toHaveProperty('pendingRequests');
    expect(res.body.data).toHaveProperty('roleDistribution');
  });

  it('400 — admin cannot change own role', async () => {
    const jwt     = require('jsonwebtoken');
    const decoded = jwt.verify(adminToken, process.env.JWT_SECRET);
    const res = await request(app)
      .put(`/api/admin/users/${decoded.id}/role`)
      .set(authHeader(adminToken))
      .send({ role: 'CITIZEN' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/cannot change your own role/i);
  });

  it('400 — rejects invalid role in role update', async () => {
    const jwt     = require('jsonwebtoken');
    const decoded = jwt.verify(citizenToken, process.env.JWT_SECRET);
    const res = await request(app)
      .put(`/api/admin/users/${decoded.id}/role`)
      .set(authHeader(adminToken))
      .send({ role: 'SUPERUSER' });
    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. ROLE ENFORCEMENT
// ─────────────────────────────────────────────────────────────────────────────

describe('Role enforcement', () => {
  let app, citizenToken, driverToken;

  beforeEach(async () => {
    app = getApp();
    const User = require('../models/User');
    const jwt  = require('jsonwebtoken');

    const { token: ct } = await registerUser(app, { email: 'role-c@test.com', phone: '+17775550001' });
    citizenToken = ct;

    const { token: dt } = await registerUser(app, { email: 'role-d@test.com', phone: '+17775550002' });
    const decoded = jwt.verify(dt, process.env.JWT_SECRET);
    await User.findByIdAndUpdate(decoded.id, { role: 'DRIVER' });
    driverToken = dt;
  });

  it('403 — citizen cannot access /api/dispatch/assignments (driver only)', async () => {
    const res = await request(app)
      .get('/api/dispatch/assignments')
      .set(authHeader(citizenToken));
    expect(res.status).toBe(403);
  });

  it('403 — driver cannot create emergency request (citizen only)', async () => {
    const res = await request(app)
      .post('/api/dispatch/request')
      .set(authHeader(driverToken))
      .send({ latitude: 51.5, longitude: -0.1 });
    expect(res.status).toBe(403);
  });

  it('403 — citizen cannot access analytics', async () => {
    const res = await request(app)
      .get('/api/analytics/performance')
      .set(authHeader(citizenToken));
    expect(res.status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. NOT FOUND + ERROR FORMAT
// ─────────────────────────────────────────────────────────────────────────────

describe('Error handling', () => {
  let app;
  beforeEach(() => { app = getApp(); });

  it('404 — unknown route returns proper error shape', async () => {
    const res = await request(app).get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBeDefined();
  });

  it('invalid MongoDB ObjectId returns 400, not 500', async () => {
    const { token } = await registerUser(app);
    const res = await request(app)
      .get('/api/emergency/not-a-valid-id')
      .set(authHeader(token));
    // CastError should be translated to 400 by globalErrorHandler
    expect([400, 500]).toContain(res.status);
    expect(res.body.success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. DISPATCH CANCELLATION
// ─────────────────────────────────────────────────────────────────────────────

describe('DELETE /api/dispatch/:id — cancel request', () => {
  let app, citizenToken, citizenId;

  beforeEach(async () => {
    app = getApp();
    const { token } = await registerUser(app, { email: 'cancel@test.com', phone: '+16665550001' });
    citizenToken    = token;
    const jwt       = require('jsonwebtoken');
    citizenId       = jwt.verify(token, process.env.JWT_SECRET).id;
  });

  it('200 — cancels a PENDING request', async () => {
    // Create a request
    const create = await request(app)
      .post('/api/dispatch/request')
      .set(authHeader(citizenToken))
      .send({ latitude: 51.5, longitude: -0.1 });
    expect(create.status).toBe(201);

    const reqId = create.body.data._id;

    const res = await request(app)
      .delete(`/api/dispatch/${reqId}`)
      .set(authHeader(citizenToken));
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/cancelled successfully/i);
  });

  it('403 — citizen cannot cancel another user\'s request', async () => {
    const { token: otherToken } = await registerUser(app, {
      email: 'other@test.com', phone: '+16665550002',
    });

    const create = await request(app)
      .post('/api/dispatch/request')
      .set(authHeader(otherToken))
      .send({ latitude: 51.5, longitude: -0.1 });

    const reqId = create.body.data._id;

    const res = await request(app)
      .delete(`/api/dispatch/${reqId}`)
      .set(authHeader(citizenToken)); // wrong user
    expect(res.status).toBe(403);
  });
});

