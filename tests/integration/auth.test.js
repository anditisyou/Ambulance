// tests/integration/auth.test.js
const request = require('supertest');
const { app } = require('../../index');
const User = require('../../models/User');

describe('Authentication API', () => {
  const testUser = {
    name: 'Test User',
    email: 'test@example.com',
    phone: '+1234567890',
    password: 'Test@1234',
    role: 'CITIZEN',
  };
  
  describe('POST /api/auth/register', () => {
    test('should register a new user successfully', async () => {
      const response = await request(app)
        .post('/api/auth/register')
        .send(testUser);
      
      expect(response.statusCode).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.user).toHaveProperty('email', testUser.email);
      expect(response.body).toHaveProperty('token');
    });
    
    test('should reject duplicate email', async () => {
      await request(app).post('/api/auth/register').send(testUser);
      
      const response = await request(app)
        .post('/api/auth/register')
        .send(testUser);
      
      expect(response.statusCode).toBe(400);
      expect(response.body.success).toBe(false);
    });
    
    test('should validate password strength', async () => {
      const weakUser = { ...testUser, email: 'weak@example.com', password: 'weak' };
      const response = await request(app)
        .post('/api/auth/register')
        .send(weakUser);
      
      expect(response.statusCode).toBe(400);
      expect(response.body.message).toMatch(/password/i);
    });
  });
  
  describe('POST /api/auth/login', () => {
    beforeEach(async () => {
      await request(app).post('/api/auth/register').send(testUser);
    });
    
    test('should login with email', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .send({ email: testUser.email, password: testUser.password });
      
      expect(response.statusCode).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body).toHaveProperty('token');
    });
    
    test('should login with phone', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .send({ phone: testUser.phone, password: testUser.password });
      
      expect(response.statusCode).toBe(200);
      expect(response.body.success).toBe(true);
    });
    
    test('should reject invalid credentials', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .send({ email: testUser.email, password: 'WrongPassword@123' });
      
      expect(response.statusCode).toBe(401);
    });
  });
  
  describe('GET /api/auth/me', () => {
    let token;
    
    beforeEach(async () => {
      const res = await request(app).post('/api/auth/register').send(testUser);
      token = res.body.token;
    });
    
    test('should return user profile with valid token', async () => {
      const response = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${token}`);
      
      expect(response.statusCode).toBe(200);
      expect(response.body.user).toHaveProperty('email', testUser.email);
      expect(response.body.user).not.toHaveProperty('password');
    });
    
    test('should reject without token', async () => {
      const response = await request(app).get('/api/auth/me');
      expect(response.statusCode).toBe(401);
    });
  });
});