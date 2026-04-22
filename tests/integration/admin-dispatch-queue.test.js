'use strict';

const mongoose = require('mongoose');
const request = require('supertest');
const { MongoMemoryServer } = require('mongodb-memory-server');
jest.setTimeout(30000);

let mongoServer;
let app;
let serverModule;

const authHeader = (token) => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  process.env.JWT_SECRET = 'integration-test-secret';
  process.env.JWT_EXPIRE = '1h';
  process.env.NODE_ENV = 'test';

  mongoServer = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongoServer.getUri();

  serverModule = require('../../server');
  app = serverModule.expressApp;
  await serverModule.waitForMongoConnection;
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
  if (serverModule?.server?.listening) {
    await new Promise((resolve) => serverModule.server.close(resolve));
  }
});

afterEach(async () => {
  const collections = mongoose.connection.collections;
  await Promise.all(
    Object.values(collections).map((collection) => collection.deleteMany({}))
  );
});

const createAdminAndToken = async () => {
  const User = require('../../models/User');

  const admin = await User.create({
    name: 'Admin User',
    email: 'admin-test@example.com',
    phone: '+15550000001',
    password: 'Secure@Pass1',
    role: 'ADMIN',
  });

  const res = await request(app)
    .post('/api/auth/login')
    .send({ email: admin.email, password: 'Secure@Pass1' });

  expect(res.status).toBe(200);
  expect(res.body.token).toBeDefined();

  return res.body.token;
};

describe('GET /api/admin/dispatch-queue', () => {
  it('returns pending emergency requests and SLA risk for admin users', async () => {
    const User = require('../../models/User');
    const EmergencyRequest = require('../../models/EmergencyRequest');

    const token = await createAdminAndToken();

    const user = await User.create({
      name: 'Requester',
      email: 'requester@example.com',
      phone: '+15550000002',
      password: 'Secure@Pass1',
      role: 'CITIZEN',
    });

    const now = new Date();
    const oldRequestTime = new Date(now.getTime() - 900 * 1000); // 15 minutes old

    await EmergencyRequest.create([
      {
        userId: user._id,
        userName: user.name,
        userPhone: user.phone,
        location: { type: 'Point', coordinates: [-73.935242, 40.73061] },
        priority: 'HIGH',
        status: 'PENDING',
        description: 'Patient unconscious',
        requestTime: oldRequestTime,
      },
      {
        userId: user._id,
        userName: user.name,
        userPhone: user.phone,
        location: { type: 'Point', coordinates: [-73.98513, 40.758896] },
        priority: 'LOW',
        status: 'PENDING',
        description: 'Minor injury',
      },
    ]);

    const res = await request(app)
      .get('/api/admin/dispatch-queue')
      .set(authHeader(token));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.count).toBe(2);
    expect(res.body.sla).toMatchObject({ totalQueued: 2 });
    expect(res.body.data.some((item) => item.priority === 'HIGH')).toBe(true);
    expect(res.body.data.some((item) => item.slaStatus === 'BREACHED')).toBe(true);
  });
});
