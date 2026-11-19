'use strict';

const mongoose = require('mongoose');
const request = require('supertest');
const { MongoMemoryServer } = require('mongodb-memory-server');

jest.setTimeout(30000);

let mongoServer;
let app;

const parseSetCookies = (setCookies = []) => setCookies.reduce((cookies, rawCookie) => {
  const [pair] = rawCookie.split(';');
  const separatorIndex = pair.indexOf('=');
  if (separatorIndex === -1) return cookies;
  const name = pair.slice(0, separatorIndex);
  const value = pair.slice(separatorIndex + 1);
  cookies[name] = value;
  return cookies;
}, {});

const registerUser = async (overrides = {}) => {
  const unique = `${Date.now()}${Math.floor(Math.random() * 100000)}`;
  const payload = {
    name: 'CSRF Test User',
    email: `csrf-${unique}@example.com`,
    phone: `+1${Math.floor(1000000000 + Math.random() * 9000000000)}`,
    password: 'Secure@Pass1',
    role: 'CITIZEN',
    ...overrides,
  };

  const res = await request(app).post('/api/auth/register').send(payload);
  return {
    res,
    token: res.body.token,
    cookies: parseSetCookies(res.headers['set-cookie']),
  };
};

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'integration-test-secret';
  process.env.JWT_EXPIRE = '1h';
  process.env.SESSION_SECRET = 'integration-session-secret';
  delete process.env.REDIS_URL;
  delete process.env.REDIS_HOST;
  delete process.env.REDIS_PORT;

  mongoServer = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongoServer.getUri();
  await mongoose.connect(process.env.MONGODB_URI);

  delete require.cache[require.resolve('../../index')];
  app = require('../../index').app;
});

afterEach(async () => {
  jest.restoreAllMocks();
  const collections = mongoose.connection.collections;
  await Promise.all(Object.values(collections).map((col) => col.deleteMany({})));
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongoServer) {
    await mongoServer.stop();
  }
});

describe('CSRF protection for cookie-authenticated browser requests', () => {
  test('allows valid cookie-authenticated state-changing requests with a matching CSRF token', async () => {
    const { cookies } = await registerUser();

    const res = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', `token=${cookies.token}; ers_csrf=${cookies.ers_csrf}`)
      .set('X-CSRF-Token', cookies.ers_csrf);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('rejects missing or invalid CSRF protection for cookie-authenticated state changes', async () => {
    const { cookies } = await registerUser();

    const missing = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', `token=${cookies.token}; ers_csrf=${cookies.ers_csrf}`);

    expect(missing.status).toBe(403);
    expect(missing.body.message).toMatch(/csrf/i);

    const invalid = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', `token=${cookies.token}; ers_csrf=${cookies.ers_csrf}`)
      .set('X-CSRF-Token', 'not-the-cookie-token');

    expect(invalid.status).toBe(403);
    expect(invalid.body.message).toMatch(/csrf/i);
  });

  test('preserves authenticated safe requests without requiring a CSRF header', async () => {
    const { cookies } = await registerUser();

    const res = await request(app)
      .get('/api/auth/me')
      .set('Cookie', `token=${cookies.token}; ers_csrf=${cookies.ers_csrf}`);

    expect(res.status).toBe(200);
    expect(res.body.user).toBeDefined();
  });

  test('preserves bearer-token API clients without requiring CSRF', async () => {
    const { token } = await registerUser();

    const res = await request(app)
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('GET /health', () => {
  test('returns 200 when critical dependencies are healthy', async () => {
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.state).toBe('healthy');
    expect(res.body.checks.database.status).toBe('healthy');
  });

  test('returns a non-2xx status when a critical dependency is degraded', async () => {
    jest.spyOn(mongoose.connection.db, 'admin').mockReturnValue({
      ping: jest.fn().mockRejectedValue(new Error('MongoDB unavailable')),
    });

    const res = await request(app).get('/health');

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('error');
    expect(res.body.state).toBe('degraded');
    expect(res.body.checks.database.status).toBe('unhealthy');
  });
});
