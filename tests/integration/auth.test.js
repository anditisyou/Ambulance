'use strict';

const mongoose = require('mongoose');
const request = require('supertest');
const { MongoMemoryServer } = require('mongodb-memory-server');
jest.setTimeout(30000);

let mongoServer;
let app;

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
});

afterEach(async () => {
  const collections = mongoose.connection.collections;
  await Promise.all(Object.values(collections).map((col) => col.deleteMany({})));
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe('Authentication API', () => {
  describe('POST /api/auth/register', () => {
    test('should register a new user successfully', async () => {
      const response = await request(app).post('/api/auth/register').send({
        name: 'Test User',
        email: 'test-register@example.com',
        phone: '+1234567890',
        password: 'Test@1234',
        role: 'CITIZEN',
      });

      expect(response.statusCode).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.user).toHaveProperty('email', 'test-register@example.com');
      expect(response.body).toHaveProperty('token');
    });

    test('should reject duplicate email', async () => {
      const payload = {
        name: 'Test User',
        email: 'duplicate@example.com',
        phone: '+1234567891',
        password: 'Test@1234',
        role: 'CITIZEN',
      };

      await request(app).post('/api/auth/register').send(payload);
      const response = await request(app).post('/api/auth/register').send(payload);

      expect(response.statusCode).toBe(400);
      expect(response.body.success).toBe(false);
    });

    test('should validate password strength', async () => {
      const response = await request(app).post('/api/auth/register').send({
        name: 'Weak User',
        email: 'weak@example.com',
        phone: '+1234567892',
        password: 'weak',
        role: 'CITIZEN',
      });

      expect(response.statusCode).toBe(400);
      expect(typeof response.body.message).toBe('string');
    });
  });

  describe('POST /api/auth/login', () => {
    const loginUser = {
      name: 'Login User',
      email: 'login@example.com',
      phone: '+1234567893',
      password: 'Test@1234',
      role: 'CITIZEN',
    };

    beforeEach(async () => {
      await request(app).post('/api/auth/register').send(loginUser);
    });

    test('should login with email', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .send({ email: loginUser.email, password: loginUser.password });

      expect(response.statusCode).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body).toHaveProperty('token');
    });

    test('should login with phone', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .send({ phone: loginUser.phone, password: loginUser.password });

      expect(response.statusCode).toBe(200);
      expect(response.body.success).toBe(true);
    });

    test('should reject invalid credentials', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .send({ email: loginUser.email, password: 'WrongPassword@123' });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('GET /api/auth/me', () => {
    let token;

    beforeEach(async () => {
      const res = await request(app).post('/api/auth/register').send({
        name: 'Profile User',
        email: 'profile@example.com',
        phone: '+1234567894',
        password: 'Test@1234',
        role: 'CITIZEN',
      });
      token = res.body.token;
    });

    test('should return user profile with valid token', async () => {
      const response = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${token}`);

      expect(response.statusCode).toBe(200);
      expect(response.body.user).toHaveProperty('email', 'profile@example.com');
      expect(response.body.user).not.toHaveProperty('password');
    });

    test('should reject without token', async () => {
      const response = await request(app).get('/api/auth/me');
      expect(response.statusCode).toBe(401);
    });
  });
});
