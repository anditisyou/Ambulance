'use strict';

const mongoose = require('mongoose');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');
jest.setTimeout(30000);

let mongoServer;
let app;
let User;

const authHeader = (token) => ({ Authorization: `Bearer ${token}` });

const registerUser = async (payload) => {
  const res = await request(app).post('/api/auth/register').send(payload);
  expect(res.statusCode).toBe(201);
  expect(res.body.token).toBeDefined();
  return res;
};

describe('Dispatch API', () => {
  let citizenToken;
  let driverToken;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = 'integration-test-secret';
    process.env.JWT_EXPIRE = '1h';
    process.env.SESSION_SECRET = 'integration-session-secret';

    mongoServer = await MongoMemoryServer.create();
    process.env.MONGODB_URI = mongoServer.getUri();

    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_URI);
    }

    delete require.cache[require.resolve('../../index')];
    app = require('../../index').app;
    User = require('../../models/User');
  });

  beforeEach(async () => {
    const citizenRes = await registerUser({
      name: 'Citizen User',
      email: 'citizen@example.com',
      phone: '+1234567890',
      password: 'Test@1234',
      role: 'CITIZEN',
    });
    citizenToken = citizenRes.body.token;

    const driverRes = await registerUser({
      name: 'Driver User',
      email: 'driver@example.com',
      phone: '+1987654321',
      password: 'Test@1234',
      role: 'DRIVER',
    });
    driverToken = driverRes.body.token;

    const decoded = jwt.verify(driverToken, process.env.JWT_SECRET);
    await User.findByIdAndUpdate(decoded.id, { role: 'DRIVER' });

    const ambRes = await request(app)
      .post('/api/ambulances')
      .set(authHeader(driverToken))
      .send({
        plateNumber: 'ERS-001',
        latitude: 40.7128,
        longitude: -74.0060,
        capacity: 1,
      });

    expect(ambRes.statusCode).toBe(201);
    expect(ambRes.body?.data?._id).toBeDefined();
  });

  afterEach(async () => {
    const collections = mongoose.connection.collections;
    await Promise.all(Object.values(collections).map((col) => col.deleteMany({})));
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  describe('POST /api/dispatch/request', () => {
    test('should create emergency request with valid location', async () => {
      const response = await request(app)
        .post('/api/dispatch/request')
        .set(authHeader(citizenToken))
        .send({
          latitude: 40.7128,
          longitude: -74.0060,
          priority: 'HIGH',
        });

      expect(response.statusCode).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveProperty('status');
      expect(['ASSIGNED', 'PENDING']).toContain(response.body.data.status);
    });

    test('should reject duplicate active requests', async () => {
      await request(app)
        .post('/api/dispatch/request')
        .set(authHeader(citizenToken))
        .send({ latitude: 40.7128, longitude: -74.0060 });

      const response = await request(app)
        .post('/api/dispatch/request')
        .set(authHeader(citizenToken))
        .send({ latitude: 40.7128, longitude: -74.0060 });

      expect(response.statusCode).toBe(400);
      expect(response.body.message).toMatch(/active emergency request|already have an active/i);
    });

    test('should validate coordinates', async () => {
      const response = await request(app)
        .post('/api/dispatch/request')
        .set(authHeader(citizenToken))
        .send({ latitude: 200, longitude: 200 });

      expect(response.statusCode).toBe(400);
    });
  });
});
