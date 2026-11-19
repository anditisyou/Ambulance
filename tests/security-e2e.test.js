'use strict';

/**
 * Security regression tests.
 *
 * These exercise the real Express app with an isolated in-memory MongoDB.
 */

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');
const socketClient = require('socket.io-client');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'security-e2e-test-secret';
process.env.JWT_EXPIRE = process.env.JWT_EXPIRE || '1h';

const User = require('../models/User');
const EmergencyRequest = require('../models/EmergencyRequest');
const AuditLog = require('../models/AuditLog');
const { encrypt, decrypt } = require('../utils/encryption');

let app;
let server;
let mongoServer;
let baseUrl;
let userId;
let token;
let validToken;
let adminId;
let adminToken;

const unique = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;

const createToken = (payload) =>
  jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '1h' });

const revokeToken = async (rawToken) => {
  const { revokeToken: revoke } = require('../middleware/auth');
  await revoke(rawToken);
};

const transitionState = async (Model, docId, newState) => {
  const { transitionState: transition } = require('../utils/transactionSafety');
  return transition(Model, docId, newState);
};

const createUser = async (role = 'CITIZEN', overrides = {}) => User.create({
  name: `${role} User`,
  email: `${unique(role.toLowerCase())}@example.com`,
  phone: `+1202${Math.floor(1000000 + Math.random() * 8999999)}`,
  password: 'SecurePassword123!',
  role,
  ...overrides,
});

const auth = (rawToken) => ({ Authorization: `Bearer ${rawToken}` });

describe('Security Tests - End-to-End Safety', () => {
  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    process.env.MONGODB_URI = mongoServer.getUri();

    const serverModule = require('../server');
    app = serverModule.expressApp || serverModule.app;
    server = serverModule.server;
    await serverModule.waitForMongoConnection;

    await new Promise((resolve) => {
      if (server.listening) return resolve();
      server.listen(0, '127.0.0.1', resolve);
    });

    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(async () => {
    for (const collection of Object.values(mongoose.connection.collections)) {
      await collection.deleteMany({});
    }

    const citizen = await createUser('CITIZEN', {
      email: 'citizen.security@example.com',
      phone: '+12025550001',
    });
    const admin = await createUser('ADMIN', {
      email: 'admin@example.com',
      phone: '+12025550002',
    });

    userId = citizen._id;
    adminId = admin._id;
    token = createToken({ id: userId, role: 'CITIZEN' });
    validToken = token;
    adminToken = createToken({ id: adminId, role: 'ADMIN' });
  });

  afterAll(async () => {
    if (server?.listening) {
      await new Promise((resolve) => server.close(resolve));
    }
    await mongoose.disconnect();
    await mongoServer?.stop();
  });

  describe('Encryption & Medical Data Protection', () => {
    test('Should encrypt medical data with AES-256-GCM', () => {
      const medicalData = {
        diagnosis: 'Heart Attack',
        treatment: 'Emergency intervention',
        allergies: 'Penicillin',
      };

      const encrypted = encrypt(JSON.stringify(medicalData));

      expect(encrypted).toHaveProperty('iv');
      expect(encrypted).toHaveProperty('ciphertext');
      expect(encrypted).toHaveProperty('authTag');
      expect(encrypted).toHaveProperty('algorithm', 'aes-256-gcm');
      expect(encrypted.ciphertext).not.toContain('Heart Attack');
    });

    test('Should decrypt medical data correctly', () => {
      const originalData = { heartRate: 120, bloodPressure: '140/90' };
      const encrypted = encrypt(JSON.stringify(originalData));
      const decrypted = JSON.parse(decrypt(encrypted));

      expect(decrypted).toEqual(originalData);
    });

    test('Should fail on tampered authentication tag', () => {
      const encrypted = encrypt('sensitive data');
      encrypted.authTag = 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF';

      expect(() => decrypt(encrypted)).toThrow();
    });

    test('Should mask passwords in logs', () => {
      const userData = {
        email: 'user@example.com',
        password: 'SecurePassword123!',
        apiKey: 'sk_live_abc123def456',
      };

      const { maskSensitiveData } = require('../middleware/enhancedErrorHandler');
      const masked = maskSensitiveData(userData);

      expect(masked.password).toBe('***REDACTED***');
      expect(masked.apiKey).toBe('***REDACTED***');
      expect(masked.email).toBe('user@example.com');
    });
  });

  describe('Authentication & Authorization', () => {
    test('Should reject requests without token', async () => {
      const res = await request(app).get('/api/admin/users').expect(401);

      expect(res.body).not.toHaveProperty('stack');
    });

    test('Should reject invalid JWT tokens', async () => {
      const res = await request(app)
        .get('/api/emergency')
        .set('Authorization', 'Bearer invalid.token.here')
        .expect(401);

      expect(res.body.message).toMatch(/invalid|authentication/i);
    });

    test('Should enforce role-based access control', async () => {
      const citizenToken = createToken({ id: userId, role: 'CITIZEN' });

      const res = await request(app)
        .get('/api/admin/users')
        .set(auth(citizenToken))
        .expect(403);

      expect(res.body.message).toContain('Access denied');
    });

    test('Should reject revoked tokens', async () => {
      const revokedToken = createToken({ id: userId, role: 'CITIZEN' });
      await revokeToken(revokedToken);

      await request(app)
        .get(`/api/medical/user/${userId}`)
        .set(auth(revokedToken))
        .expect(401);
    });

    test('Should not expose user enumeration', async () => {
      const realRes = await request(app)
        .post('/api/auth/login')
        .send({ email: 'admin@example.com', password: 'wrong' })
        .expect(401);

      const fakeRes = await request(app)
        .post('/api/auth/login')
        .send({ email: 'doesnotexist@example.com', password: 'wrong' })
        .expect(401);

      expect(realRes.body.message).toBe(fakeRes.body.message);
    });
  });

  describe('Input Validation & Sanitization', () => {
    test('Should reject MongoDB injection attempts', async () => {
      const res = await request(app)
        .post('/api/emergency')
        .set(auth(token))
        .send({
          description: { $ne: null },
          latitude: 0,
          longitude: 0,
        })
        .expect(400);

      expect(res.body.message).toMatch(/validation|cast|description/i);
    });

    test('Should sanitize or reject XSS attempts', async () => {
      const xssPayload = '<script>alert("XSS")</script>';

      const res = await request(app)
        .post('/api/emergency')
        .set(auth(token))
        .send({
          description: xssPayload,
          latitude: 0,
          longitude: 0,
        });

      expect([201, 400]).toContain(res.status);
      const stored = res.body?.data?._id
        ? await EmergencyRequest.findById(res.body.data._id)
        : null;
      expect(stored?.description).not.toContain('<script>');
    });

    test('Should validate location coordinates', async () => {
      const res = await request(app)
        .post('/api/emergency')
        .set(auth(token))
        .send({
          description: 'Test',
          longitude: 999,
          latitude: 999,
        })
        .expect(400);

      expect(res.body.message).toMatch(/coordinate|validation/i);
    });

    test('Should limit request body size', async () => {
      const largePayload = 'x'.repeat(20 * 1024 * 1024);

      await request(app)
        .post('/api/emergency')
        .set(auth(token))
        .send({ description: largePayload })
        .expect(413);
    });

    test('Should validate email format', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({
          name: 'Invalid Email',
          email: 'invalid-email',
          password: 'SecurePass123!',
          phone: '+12025551234',
        })
        .expect(400);

      expect(res.body.message).toMatch(/email/i);
    });
  });

  describe('Error Message Safety', () => {
    test('Should not expose stack traces in production', async () => {
      const previousEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';

      try {
        const res = await request(app)
          .get('/api/emergency/invalid-id')
          .set(auth(token))
          .expect(400);

        expect(res.body).not.toHaveProperty('stack');
        expect(res.body).not.toHaveProperty('error.stack');
      } finally {
        process.env.NODE_ENV = previousEnv;
      }
    });

    test('Should not expose database details in normal responses', async () => {
      const res = await request(app)
        .post('/api/emergency')
        .set(auth(token))
        .send({
          description: 'Test',
          latitude: 0,
          longitude: 0,
        })
        .expect(201);

      const message = JSON.stringify(res.body);
      expect(message).not.toMatch(/mongodb/i);
      expect(message).not.toMatch(/query/i);
    });

    test('Should not expose passwords in error messages', async () => {
      const password = 'Secretpassword123!';
      await request(app)
        .post('/api/auth/register')
        .send({
          name: 'Password Test',
          email: 'password-test@example.com',
          password,
          phone: '+12025551235',
        })
        .expect(201);

      const loginRes = await request(app)
        .post('/api/auth/login')
        .send({
          email: 'password-test@example.com',
          password: 'wrongpassword',
        })
        .expect(401);

      expect(JSON.stringify(loginRes.body)).not.toContain(password);
      expect(JSON.stringify(loginRes.body)).not.toContain('wrongpassword');
    });
  });

  describe('Rate Limiting & DDoS Protection', () => {
    test('Should reject repeated invalid login attempts consistently', async () => {
      const responses = [];
      for (let i = 0; i < 3; i++) {
        responses.push(await request(app)
          .post('/api/auth/login')
          .send({ email: 'missing@example.com', password: 'wrong' }));
      }

      expect(responses.every((res) => res.status === 401)).toBe(true);
      expect(new Set(responses.map((res) => res.body.message)).size).toBe(1);
    });

    test('Should rate limit emergency creation', async () => {
      const requests = [];
      for (let i = 0; i < 8; i++) {
        requests.push(request(app)
          .post('/api/emergency')
          .set(auth(token))
          .send({
            description: `Request ${i}`,
            longitude: i,
            latitude: i,
          }));
      }

      const results = await Promise.all(requests);
      const rateLimited = results.filter((res) => res.status === 429);

      expect(rateLimited.length).toBeGreaterThan(0);
    });

    test('Should serve authenticated health checks under ordinary request bursts', async () => {
      const results = await Promise.all(Array.from({ length: 10 }, () =>
        request(app).get('/health').set(auth(token))));

      expect(results.filter((res) => res.status === 200).length).toBeGreaterThan(0);
    });
  });

  describe('State Machine Validation', () => {
    test('Should not allow invalid state transitions', async () => {
      const emergency = await EmergencyRequest.create({
        userId,
        userName: 'Test User',
        userPhone: '+12025551234',
        location: { type: 'Point', coordinates: [0, 0] },
        status: 'PENDING',
      });

      await expect(
        transitionState(EmergencyRequest, emergency._id, 'HOSPITAL_ARRIVED')
      ).rejects.toThrow(/transition/i);
    });

    test('Should track state transition history', async () => {
      const emergency = await EmergencyRequest.create({
        userId,
        userName: 'Test User',
        userPhone: '+12025551234',
        location: { type: 'Point', coordinates: [0, 0] },
        status: 'PENDING',
      });

      await transitionState(EmergencyRequest, emergency._id, 'ASSIGNED');
      await transitionState(EmergencyRequest, emergency._id, 'ACCEPTED');

      const updated = await EmergencyRequest.findById(emergency._id);

      expect(updated.stateHistory).toBeDefined();
      expect(updated.stateHistory).toHaveLength(2);
      expect(updated.stateHistory[0].from).toBe('PENDING');
      expect(updated.stateHistory[0].to).toBe('ASSIGNED');
      expect(updated.status).toBe('ACCEPTED');
      expect(updated.assignmentState).toBe('ACCEPTED');
    });
  });

  describe('Audit Logging', () => {
    test('Should log all critical operations', async () => {
      const { logAudit, AUDIT_ACTIONS } = require('../utils/auditLog');

      await logAudit({
        action: AUDIT_ACTIONS.EMERGENCY_CREATED,
        userId,
        resourceType: 'EmergencyRequest',
        status: 'SUCCESS',
      });

      const auditLog = await AuditLog.findOne({
        userId,
        action: AUDIT_ACTIONS.EMERGENCY_CREATED,
      });

      expect(auditLog).toBeDefined();
      expect(auditLog.timestamp).toBeDefined();
    });

    test('Should mask sensitive data in audit logs', async () => {
      const { logAudit, AUDIT_ACTIONS } = require('../utils/auditLog');

      await logAudit({
        action: AUDIT_ACTIONS.USER_UPDATED,
        userId,
        details: {
          password: 'SecurePassword123',
          token: 'secret_token_123',
        },
        status: 'SUCCESS',
      });

      const auditLog = await AuditLog.findOne({
        userId,
        action: AUDIT_ACTIONS.USER_UPDATED,
      });

      expect(auditLog.details.password).toBe('***REDACTED***');
      expect(auditLog.details.token).toBe('***REDACTED***');
    });
  });

  describe('WebSocket Security', () => {
    test('Should authenticate WebSocket connections', async () => {
      const socket = socketClient(baseUrl, {
        autoConnect: false,
        auth: { token: 'invalid' },
      });

      await new Promise((resolve) => {
        socket.on('connect_error', (err) => {
          expect(err.message).toContain('Authentication');
          resolve();
        });
        socket.connect();
      });

      socket.close();
    });

    test('Should reject revoked tokens on Socket.IO', async () => {
      const revokedToken = createToken({ id: userId });
      await revokeToken(revokedToken);

      const socket = socketClient(baseUrl, {
        autoConnect: false,
        auth: { token: revokedToken },
      });

      await new Promise((resolve) => {
        socket.on('connect_error', (err) => {
          expect(err.message).toContain('Authentication');
          resolve();
        });
        socket.connect();
      });

      socket.close();
    });

    test('Should accept authenticated WebSocket connections', async () => {
      const socket = socketClient(baseUrl, {
        auth: { token: validToken },
      });

      await new Promise((resolve, reject) => {
        socket.on('connect', resolve);
        socket.on('connect_error', reject);
      });

      socket.close();
    });
  });
});
