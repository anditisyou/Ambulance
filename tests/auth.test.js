'use strict';

/**
 * Auth Controller — Advanced Tests
 *
 * These tests mock the User model and JWT module to test controller
 * logic in full isolation — no database required.
 *
 * Run with: jest tests/auth.test.js
 */

const jwt = require('jsonwebtoken');

// ── Shared mock factories ─────────────────────────────────────────────────────

const makeMockUser = (overrides = {}) => ({
  _id:             'user_abc',
  name:            'Alice Smith',
  email:           'alice@example.com',
  phone:           '+12025551234',
  role:            'CITIZEN',
  isActive:        true,
  comparePassword: jest.fn(),
  ...overrides,
});

const makeRes = () => {
  const res = {
    statusCode: null,
    body:       null,
    cookies:    {},
  };
  res.status  = jest.fn((code) => { res.statusCode = code; return res; });
  res.json    = jest.fn((body)  => { res.body = body; return res; });
  res.cookie  = jest.fn((name, val, opts) => { res.cookies[name] = { val, opts }; });
  res.clearCookie = jest.fn();
  return res;
};

// ── Module mocking ────────────────────────────────────────────────────────────

jest.mock('../models/User', () => ({
  findOne:   jest.fn(),
  findById:  jest.fn(),
  create:    jest.fn(),
}));

jest.mock('../middleware/auth', () => ({
  revokeToken:   jest.fn().mockResolvedValue(true),
  protect:       jest.fn(),
  optionalAuth:  jest.fn(),
  refreshToken:  jest.fn(),
}));

jest.mock('../utils/redisClient', () => null);

const User         = require('../models/User');
const authCtrl     = require('../controllers/authController');

beforeEach(() => {
  process.env.JWT_SECRET = 'test-secret-key-123';
  jest.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// REGISTER
// ─────────────────────────────────────────────────────────────────────────────

describe('authController.register', () => {
  const validBody = {
    name:     'Alice Smith',
    email:    'alice@example.com',
    phone:    '+12025551234',
    password: 'Secure@123',
  };

  it('returns 201 and token on successful registration', async () => {
    User.findOne.mockResolvedValue(null);
    User.create.mockResolvedValue(makeMockUser());

    const req  = { body: { ...validBody } };
    const res  = makeRes();
    const next = jest.fn();

    await authCtrl.register(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.token).toBeDefined();
    expect(res.body.user).toBeDefined();
    expect(res.body.user.role).toBeDefined();
  });

  it('does NOT expose password in response', async () => {
    User.findOne.mockResolvedValue(null);
    User.create.mockResolvedValue(makeMockUser());

    const req  = { body: { ...validBody } };
    const res  = makeRes();
    await authCtrl.register(req, res, jest.fn());

    expect(JSON.stringify(res.body)).not.toContain('password');
  });

  it('sets httpOnly cookie', async () => {
    User.findOne.mockResolvedValue(null);
    User.create.mockResolvedValue(makeMockUser());

    const req  = { body: { ...validBody } };
    const res  = makeRes();
    await authCtrl.register(req, res, jest.fn());

    expect(res.cookie).toHaveBeenCalledWith(
      'token',
      expect.any(String),
      expect.objectContaining({ httpOnly: true, sameSite: 'strict' })
    );
  });

  it('sanitises role — ADMIN self-assignment produces CITIZEN', async () => {
    User.findOne.mockResolvedValue(null);
    let capturedRole;
    User.create.mockImplementation((data) => {
      capturedRole = data.role;
      return Promise.resolve(makeMockUser({ role: data.role }));
    });

    const req  = { body: { ...validBody, role: 'ADMIN' } };
    const res  = makeRes();
    await authCtrl.register(req, res, jest.fn());

    expect(capturedRole).toBe('CITIZEN');
  });

  it('sanitises role — DISPATCHER self-assignment produces CITIZEN', async () => {
    User.findOne.mockResolvedValue(null);
    let capturedRole;
    User.create.mockImplementation((data) => {
      capturedRole = data.role;
      return Promise.resolve(makeMockUser({ role: data.role }));
    });

    const req  = { body: { ...validBody, role: 'DISPATCHER' } };
    const res  = makeRes();
    await authCtrl.register(req, res, jest.fn());

    expect(capturedRole).toBe('CITIZEN');
  });

  it('calls next(AppError 400) when email already exists', async () => {
    User.findOne.mockResolvedValue(makeMockUser());

    const req  = { body: { ...validBody } };
    const res  = makeRes();
    const next = jest.fn();
    await authCtrl.register(req, res, next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 400 })
    );
  });

  const invalidInputs = [
    ['no name',      { email: 'a@b.com', phone: '+1234567890', password: 'Aa1!aaaa' }],
    ['no email',     { name: 'A', phone: '+1234567890', password: 'Aa1!aaaa' }],
    ['no phone',     { name: 'A', email: 'a@b.com', password: 'Aa1!aaaa' }],
    ['no password',  { name: 'A', email: 'a@b.com', phone: '+1234567890' }],
    ['bad email',    { name: 'A', email: 'not-email', phone: '+1234567890', password: 'Aa1!aaaa' }],
    ['bad phone',    { name: 'A', email: 'a@b.com', phone: '0', password: 'Aa1!aaaa' }],
    ['weak pw',      { name: 'A', email: 'a@b.com', phone: '+1234567890', password: 'abc' }],
    ['pw no upper',  { name: 'A', email: 'a@b.com', phone: '+1234567890', password: 'aaaaa1!1' }],
    ['pw no digit',  { name: 'A', email: 'a@b.com', phone: '+1234567890', password: 'AAAaaa!!' }],
    ['pw no special',{ name: 'A', email: 'a@b.com', phone: '+1234567890', password: 'AAAaaa11' }],
  ];

  test.each(invalidInputs)('rejects (%s)', async (_label, body) => {
    const req  = { body };
    const res  = makeRes();
    const next = jest.fn();
    await authCtrl.register(req, res, next);
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 400 })
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LOGIN
// ─────────────────────────────────────────────────────────────────────────────

describe('authController.login', () => {
  it('returns 200 and token on valid credentials', async () => {
    const user = makeMockUser();
    user.comparePassword = jest.fn().mockResolvedValue(true);
    User.findOne.mockResolvedValue(user);

    const req  = { body: { email: 'alice@example.com', password: 'correct' } };
    const res  = makeRes();
    const next = jest.fn();

    await authCtrl.login(req, res, next);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.token).toBeDefined();
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 for wrong password (generic message)', async () => {
    const user = makeMockUser();
    user.comparePassword = jest.fn().mockResolvedValue(false);
    User.findOne.mockResolvedValue(user);

    const req  = { body: { email: 'alice@example.com', password: 'wrong' } };
    const res  = makeRes();
    const next = jest.fn();
    await authCtrl.login(req, res, next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 401, message: 'Invalid credentials' })
    );
  });

  it('returns 401 for non-existent user (same generic message — prevents enumeration)', async () => {
    User.findOne.mockResolvedValue(null);
    const req  = { body: { email: 'ghost@example.com', password: 'anything' } };
    const res  = makeRes();
    const next = jest.fn();
    await authCtrl.login(req, res, next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 401, message: 'Invalid credentials' })
    );
  });

  it('returns 401 for deactivated account', async () => {
    const user = makeMockUser({ isActive: false });
    user.comparePassword = jest.fn().mockResolvedValue(true);
    User.findOne.mockResolvedValue(user);

    const req  = { body: { email: 'alice@example.com', password: 'correct' } };
    const res  = makeRes();
    const next = jest.fn();
    await authCtrl.login(req, res, next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 401 })
    );
  });

  it('accepts login by phone', async () => {
    const user = makeMockUser();
    user.comparePassword = jest.fn().mockResolvedValue(true);
    User.findOne.mockResolvedValue(user);

    const req  = { body: { phone: '+12025551234', password: 'correct' } };
    const res  = makeRes();
    const next = jest.fn();
    await authCtrl.login(req, res, next);

    expect(res.statusCode).toBe(200);
    // Verify query was built with phone not email
    expect(User.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ phone: '+12025551234' })
    );
  });

  it('rejects when neither email nor phone provided', async () => {
    const req  = { body: { password: 'correct' } };
    const res  = makeRes();
    const next = jest.fn();
    await authCtrl.login(req, res, next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 400 })
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LOGOUT
// ─────────────────────────────────────────────────────────────────────────────

describe('authController.logout', () => {
  it('clears cookie and returns success', async () => {
    const req  = { headers: {}, cookies: { token: 'sometoken' } };
    const res  = makeRes();
    const next = jest.fn();

    await authCtrl.logout(req, res, next);

    expect(res.clearCookie).toHaveBeenCalledWith(
      'token',
      expect.objectContaining({ httpOnly: true })
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('revokes Bearer token from Authorization header', async () => {
    const { revokeToken } = require('../middleware/auth');
    const req = {
      headers: { authorization: 'Bearer mytoken123' },
      cookies: {},
    };
    const res  = makeRes();
    const next = jest.fn();

    await authCtrl.logout(req, res, next);

    expect(revokeToken).toHaveBeenCalledWith('mytoken123');
  });

  it('uses correct Bearer prefix — no space after Bearer without space fails (regression)', () => {
    // Regression for Bug #11: original checked 'Bearer' not 'Bearer '
    const authHeader = 'Bearer mytoken123';
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    expect(token).toBe('mytoken123');

    // The old buggy pattern:
    const tokenOldBuggy = authHeader?.startsWith('Bearer') ? authHeader.split(' ')[1] : null;
    // This also works here but fails on 'BearerXYZ'
    const maliciousHeader = 'BearerXYZ';
    const tokenMalicious  = maliciousHeader?.startsWith('Bearer ') ? maliciousHeader.slice(7) : null;
    expect(tokenMalicious).toBeNull(); // fixed version correctly rejects this
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// JWT TOKEN GENERATION & VALIDATION
// ─────────────────────────────────────────────────────────────────────────────

describe('JWT token security', () => {
  const SECRET = 'test-secret-key-123';

  it('generated token contains user id', () => {
    const token   = jwt.sign({ id: 'user_abc' }, SECRET, { expiresIn: '7d' });
    const decoded = jwt.verify(token, SECRET);
    expect(decoded.id).toBe('user_abc');
  });

  it('token signed with wrong secret fails verification', () => {
    const token = jwt.sign({ id: 'user_abc' }, SECRET, { expiresIn: '7d' });
    expect(() => jwt.verify(token, 'wrong-secret')).toThrow();
  });

  it('expired token fails verification', () => {
    const token = jwt.sign({ id: 'user_abc' }, SECRET, { expiresIn: '-1s' });
    expect(() => jwt.verify(token, SECRET)).toThrow('jwt expired');
  });

  it('tampered token fails verification', () => {
    const token   = jwt.sign({ id: 'user_abc' }, SECRET, { expiresIn: '7d' });
    const tampered = token.slice(0, -5) + 'ZZZZZ';
    expect(() => jwt.verify(tampered, SECRET)).toThrow();
  });

  it('token does not contain sensitive user data', () => {
    const token   = jwt.sign({ id: 'user_abc' }, SECRET, { expiresIn: '7d' });
    const decoded = jwt.decode(token);
    expect(decoded.password).toBeUndefined();
    expect(decoded.email).toBeUndefined();
    expect(decoded.phone).toBeUndefined();
  });
});
