'use strict';

const mongoose = require('mongoose');
const request = require('supertest');
const { MongoMemoryServer } = require('mongodb-memory-server');

async function main() {
  process.env.JWT_SECRET = 'runtime-test-secret';
  process.env.JWT_EXPIRE = '1h';
  process.env.NODE_ENV = 'test';

  const mongoServer = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongoServer.getUri();

  const serverModule = require('../server');
  const app = serverModule.expressApp;

  await new Promise((resolve, reject) => {
    if (mongoose.connection.readyState === 1) return resolve();
    mongoose.connection.on('connected', resolve);
    mongoose.connection.on('error', reject);
  });

  const User = require('../models/User');
  const EmergencyRequest = require('../models/EmergencyRequest');

  const admin = await User.create({
    name: 'Admin User',
    email: 'admin-runtime@example.com',
    phone: '+15550000003',
    password: 'Secure@Pass1',
    role: 'ADMIN',
  });

  const loginRes = await request(app)
    .post('/api/auth/login')
    .send({ email: admin.email, password: 'Secure@Pass1' });

  if (loginRes.status !== 200) {
    throw new Error(`Login failed: ${loginRes.status} ${JSON.stringify(loginRes.body)}`);
  }

  const token = loginRes.body.token;
  console.log('Admin token acquired');

  const user = await User.create({
    name: 'Requester',
    email: 'requester-runtime@example.com',
    phone: '+15550000004',
    password: 'Secure@Pass1',
    role: 'CITIZEN',
  });

  const now = new Date();
  const staleTime = new Date(now.getTime() - 900 * 1000); // 15 minutes old to exceed HIGH SLA target

  await EmergencyRequest.create([
    {
      userId: user._id,
      userName: user.name,
      userPhone: user.phone,
      description: 'Patient unconscious',
      priority: 'HIGH',
      status: 'PENDING',
      location: { type: 'Point', coordinates: [-73.935242, 40.73061] },
      requestTime: staleTime,
    },
    {
      userId: user._id,
      userName: user.name,
      userPhone: user.phone,
      description: 'Minor injury',
      priority: 'LOW',
      status: 'PENDING',
      location: { type: 'Point', coordinates: [-73.98513, 40.758896] },
    },
  ]);

  const res = await request(app)
    .get('/api/admin/dispatch-queue')
    .set('Authorization', `Bearer ${token}`);

  console.log('Dispatch queue response status:', res.status);
  console.log('Dispatch queue body:', JSON.stringify(res.body, null, 2));

  if (res.status !== 200) {
    throw new Error('Dispatch queue endpoint returned non-200 status');
  }

  if (!res.body.success || res.body.count !== 2) {
    throw new Error('Dispatch queue response did not contain the expected pending requests');
  }

  if (!res.body.data.some((item) => item.slaStatus === 'BREACHED')) {
    throw new Error('Expected at least one breached SLA item');
  }

  console.log('Dispatch queue runtime validation succeeded');

  await mongoose.disconnect();
  await mongoServer.stop();
}

main().catch((err) => {
  console.error('Runtime validation failed:', err);
  process.exit(1);
});
