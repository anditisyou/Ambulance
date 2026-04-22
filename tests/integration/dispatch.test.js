// tests/integration/dispatch.test.js
const request = require('supertest');
const { app } = require('../../index');
const User = require('../../models/User');
const Ambulance = require('../../models/Ambulance');

describe('Dispatch API', () => {
  let citizenToken, driverToken, ambulanceId, citizenUser;
  
  beforeAll(async () => {
    // Create test citizen
    const citizenRes = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Citizen User',
        email: 'citizen@example.com',
        phone: '+1234567890',
        password: 'Test@1234',
        role: 'CITIZEN',
      });
    citizenToken = citizenRes.body.token;
    citizenUser = citizenRes.body.user;
    
    // Create test driver
    const driverRes = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Driver User',
        email: 'driver@example.com',
        phone: '+1987654321',
        password: 'Test@1234',
        role: 'DRIVER',
      });
    driverToken = driverRes.body.token;
    
    // Register ambulance
    const ambRes = await request(app)
      .post('/api/ambulances')
      .set('Authorization', `Bearer ${driverToken}`)
      .send({
        plateNumber: 'ERS-001',
        latitude: 40.7128,
        longitude: -74.0060,
        capacity: 1,
      });
    ambulanceId = ambRes.body.data._id;
  });
  
  describe('POST /api/dispatch/request', () => {
    test('should create emergency request with valid location', async () => {
      const response = await request(app)
        .post('/api/dispatch/request')
        .set('Authorization', `Bearer ${citizenToken}`)
        .send({
          latitude: 40.7128,
          longitude: -74.0060,
          priority: 'HIGH',
        });
      
      expect(response.statusCode).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveProperty('status', 'ASSIGNED');
    });
    
    test('should reject duplicate active requests', async () => {
      await request(app)
        .post('/api/dispatch/request')
        .set('Authorization', `Bearer ${citizenToken}`)
        .send({ latitude: 40.7128, longitude: -74.0060 });
      
      const response = await request(app)
        .post('/api/dispatch/request')
        .set('Authorization', `Bearer ${citizenToken}`)
        .send({ latitude: 40.7128, longitude: -74.0060 });
      
      expect(response.statusCode).toBe(400);
      expect(response.body.message).toMatch(/active emergency request/i);
    });
    
    test('should validate coordinates', async () => {
      const response = await request(app)
        .post('/api/dispatch/request')
        .set('Authorization', `Bearer ${citizenToken}`)
        .send({ latitude: 200, longitude: 200 });
      
      expect(response.statusCode).toBe(400);
    });
  });
});