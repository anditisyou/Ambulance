// scripts/test-api.js
const axios = require('axios');
const mongoose = require('mongoose');
require('dotenv').config();

const BASE_URL = process.env.TEST_API_URL || 'http://localhost:3000/api';
let authToken = null;
let testUserId = null;
let testRequestId = null;
let testAmbulanceId = null;

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
};

const log = {
  info: (msg) => console.log(`${colors.blue}[INFO]${colors.reset} ${msg}`),
  success: (msg) => console.log(`${colors.green}[PASS]${colors.reset} ${msg}`),
  error: (msg) => console.log(`${colors.red}[FAIL]${colors.reset} ${msg}`),
  warn: (msg) => console.log(`${colors.yellow}[WARN]${colors.reset} ${msg}`),
  test: (name) => console.log(`\n${colors.yellow}▶ Testing:${colors.reset} ${name}`),
};

async function testApi() {
  console.log('\n' + '='.repeat(60));
  console.log(`${colors.blue}🚑 ERS API Integration Test Suite${colors.reset}`);
  console.log('='.repeat(60) + '\n');

  try {
    // ============================================
    // 1. HEALTH CHECK
    // ============================================
    log.test('Health Check');
    try {
      const response = await axios.get(`${BASE_URL.replace('/api', '')}/health`);
      if (response.data.status === 'ok') {
        log.success('Server is healthy');
      } else {
        log.error('Health check failed');
      }
    } catch (error) {
      log.error(`Health check failed: ${error.message}`);
      return;
    }

    // ============================================
    // 2. AUTHENTICATION TESTS
    // ============================================
    log.test('User Registration');
    const testUser = {
      name: `Test_User_${Date.now()}`,
      email: `user${Date.now()}@test.com`,
      phone: `+1${Math.floor(Math.random() * 9000000000) + 1000000000}`,
      password: 'Test@1234',
      role: 'CITIZEN',
    };

    try {
      const registerRes = await axios.post(`${BASE_URL}/auth/register`, testUser);
      if (registerRes.data.success) {
        log.success('User registered successfully');
        authToken = registerRes.data.token;
        testUserId = registerRes.data.user.id;
        log.info(`User ID: ${testUserId}`);
        log.info(`Token: ${authToken.substring(0, 30)}...`);
      } else {
        log.error('Registration failed');
      }
    } catch (error) {
      log.error(`Registration error: ${error.response?.data?.message || error.message}`);
    }

    log.test('Duplicate Registration');
    try {
      await axios.post(`${BASE_URL}/auth/register`, testUser);
      log.error('Duplicate registration should have failed');
    } catch (error) {
      if (error.response?.status === 400) {
        log.success('Duplicate registration correctly rejected');
      } else {
        log.error(`Unexpected error: ${error.message}`);
      }
    }

    log.test('Login with Email');
    try {
      const loginRes = await axios.post(`${BASE_URL}/auth/login`, {
        email: testUser.email,
        password: testUser.password,
      });
      if (loginRes.data.success) {
        log.success('Email login successful');
        authToken = loginRes.data.token;
      }
    } catch (error) {
      log.error(`Email login failed: ${error.response?.data?.message}`);
    }

    log.test('Login with Phone');
    try {
      const loginRes = await axios.post(`${BASE_URL}/auth/login`, {
        phone: testUser.phone,
        password: testUser.password,
      });
      if (loginRes.data.success) {
        log.success('Phone login successful');
      }
    } catch (error) {
      log.error(`Phone login failed: ${error.response?.data?.message}`);
    }

    log.test('Invalid Login');
    try {
      await axios.post(`${BASE_URL}/auth/login`, {
        email: testUser.email,
        password: 'WrongPassword@123',
      });
      log.error('Invalid login should have failed');
    } catch (error) {
      if (error.response?.status === 401) {
        log.success('Invalid login correctly rejected');
      }
    }

    // ============================================
    // 3. GET CURRENT USER
    // ============================================
    log.test('Get Current User');
    try {
      const meRes = await axios.get(`${BASE_URL}/auth/me`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (meRes.data.success && meRes.data.user.email === testUser.email) {
        log.success('Current user retrieved correctly');
      } else {
        log.error('Current user mismatch');
      }
    } catch (error) {
      log.error(`Failed to get user: ${error.message}`);
    }

    // ============================================
    // 4. AMBULANCE REGISTRATION (DRIVER)
    // ============================================
    log.test('Driver Registration & Ambulance Setup');
    
    // First create a driver user
    const driverUser = {
      name: `Driver_${Date.now()}`,
      email: `driver${Date.now()}@test.com`,
      phone: `+1${Math.floor(Math.random() * 9000000000) + 1000000000}`,
      password: 'Test@1234',
      role: 'DRIVER',
    };
    
    let driverToken;
    try {
      const driverReg = await axios.post(`${BASE_URL}/auth/register`, driverUser);
      if (driverReg.data.success) {
        driverToken = driverReg.data.token;
        log.success('Driver registered');
      }
    } catch (error) {
      log.error(`Driver registration failed: ${error.message}`);
    }

    log.test('Register Ambulance');
    try {
      const ambRes = await axios.post(
        `${BASE_URL}/ambulances`,
        {
          plateNumber: `AMB-${Math.floor(Math.random() * 1000)}`,
          latitude: 40.7128,
          longitude: -74.0060,
          capacity: 1,
          equipment: ['Stretcher', 'Oxygen', 'Defibrillator'],
        },
        { headers: { Authorization: `Bearer ${driverToken}` } }
      );
      
      if (ambRes.data.success) {
        log.success('Ambulance registered successfully');
        testAmbulanceId = ambRes.data.data._id;
        log.info(`Ambulance ID: ${testAmbulanceId}`);
      } else {
        log.error('Ambulance registration failed');
      }
    } catch (error) {
      log.error(`Ambulance registration error: ${error.response?.data?.message}`);
    }

    // ✅ FIXED: Use driver token instead of citizen token for ambulance list
    log.test('Get All Ambulances');
    try {
      const ambList = await axios.get(`${BASE_URL}/ambulances`, {
        headers: { Authorization: `Bearer ${driverToken}` }, // ✅ Changed from authToken to driverToken
      });
      if (ambList.data.success && ambList.data.data.length > 0) {
        log.success(`Retrieved ${ambList.data.data.length} ambulances`);
      } else {
        log.warn('No ambulances found');
      }
    } catch (error) {
      log.error(`Failed to get ambulances: ${error.message}`);
    }

    log.test('Update Ambulance Location');
    try {
      const updateRes = await axios.patch(
        `${BASE_URL}/ambulances/${testAmbulanceId}/location`,
        { latitude: 40.7130, longitude: -74.0055 },
        { headers: { Authorization: `Bearer ${driverToken}` } }
      );
      if (updateRes.data.success) {
        log.success('Location updated');
      } else {
        log.error('Location update failed');
      }
    } catch (error) {
      log.error(`Location update error: ${error.message}`);
    }

    // ============================================
    // 5. EMERGENCY REQUEST (DISPATCH)
    // ============================================
    log.test('Create Emergency Request');
    try {
      const emergencyRes = await axios.post(
        `${BASE_URL}/dispatch/request`,
        {
          latitude: 40.7128,
          longitude: -74.0060,
          priority: 'HIGH',
          type: 'MEDICAL',
          description: 'Test emergency request',
        },
        { headers: { Authorization: `Bearer ${authToken}` } }
      );
      
      if (emergencyRes.data.success) {
        log.success('Emergency request created');
        testRequestId = emergencyRes.data.data._id;
        log.info(`Request ID: ${testRequestId}`);
        log.info(`Allocated: ${emergencyRes.data.allocated}`);
      } else {
        log.error('Emergency request failed');
      }
    } catch (error) {
      log.error(`Emergency request error: ${error.response?.data?.message}`);
    }

    // ============================================
    // 6. GET ACTIVE EMERGENCY
    // ============================================
    log.test('Get Active Emergency');
    try {
      const activeRes = await axios.get(`${BASE_URL}/dispatch/active`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      
      if (activeRes.data.success) {
        log.success('Active emergency retrieved');
        if (activeRes.data.data) {
          log.info(`Status: ${activeRes.data.data.status}`);
          if (activeRes.data.data.eta) {
            log.info(`ETA: ${activeRes.data.data.eta} minutes`);
          }
        } else {
          log.warn('No active emergency');
        }
      }
    } catch (error) {
      log.error(`Failed to get active emergency: ${error.message}`);
    }

    // ============================================
    // 7. DRIVER RESPONSE
    // ============================================
    if (testRequestId) {
      log.test('Driver Response (Accept)');
      try {
        const responseRes = await axios.put(
          `${BASE_URL}/dispatch/${testRequestId}/response`,
          { accept: true },
          { headers: { Authorization: `Bearer ${driverToken}` } }
        );
        
        if (responseRes.data.success) {
          log.success('Driver accepted assignment');
        } else {
          log.warn('Driver response may not be applicable');
        }
      } catch (error) {
        log.warn(`Driver response error: ${error.response?.data?.message || error.message}`);
      }
    }

    // ============================================
    // 8. MEDICAL RECORD UPLOAD
    // ============================================
    log.test('Medical Record Upload');
    
    // Note: This requires a file upload - testing with a simple text file
    const FormData = require('form-data');
    const fs = require('fs');
    const path = require('path');
    
    // Create a test file
    const testFilePath = path.join(__dirname, 'test-file.txt');
    fs.writeFileSync(testFilePath, 'Test medical record content');
    
    try {
      const formData = new FormData();
      formData.append('file', fs.createReadStream(testFilePath), {
        filename: 'test-record.txt',
        contentType: 'text/plain',
      });
      
      const uploadRes = await axios.post(
        `${BASE_URL}/medical/upload`,
        formData,
        {
          headers: {
            Authorization: `Bearer ${authToken}`,
            ...formData.getHeaders(),
          },
        }
      );
      
      if (uploadRes.data.success) {
        log.success('Medical record uploaded');
        log.info(`Record ID: ${uploadRes.data.data._id}`);
      } else {
        log.warn('Medical record upload may have validation issues (expected with .txt)');
      }
    } catch (error) {
      log.warn(`Upload error (expected if not image/pdf): ${error.response?.data?.message || error.message}`);
    } finally {
      // Clean up test file
      if (fs.existsSync(testFilePath)) fs.unlinkSync(testFilePath);
    }

    log.test('Get Medical Records');
    try {
      const recordsRes = await axios.get(`${BASE_URL}/medical/${testUserId}`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      
      if (recordsRes.data.success) {
        log.success(`Retrieved ${recordsRes.data.data.length} medical records`);
      }
    } catch (error) {
      log.error(`Failed to get medical records: ${error.message}`);
    }

    // ============================================
    // 9. ADMIN DASHBOARD
    // ============================================
    log.test('Admin Statistics');
    try {
      const statsRes = await axios.get(`${BASE_URL}/admin/stats`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      
      if (statsRes.data.success) {
        log.success('Statistics retrieved');
        log.info(`Total Users: ${statsRes.data.data.totalUsers}`);
        log.info(`Total Ambulances: ${statsRes.data.data.totalAmbulances}`);
        log.info(`Pending Requests: ${statsRes.data.data.pendingRequests}`);
      } else if (statsRes.status === 403) {
        log.warn('Admin access requires ADMIN role');
      }
    } catch (error) {
      if (error.response?.status === 403) {
        log.warn('Admin statistics require ADMIN role (expected)');
      } else {
        log.error(`Failed to get stats: ${error.message}`);
      }
    }

    // ============================================
    // 10. ANALYTICS
    // ============================================
    log.test('Analytics - Latency Metrics');
    try {
      const latencyRes = await axios.get(`${BASE_URL}/analytics/latency`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      
      if (latencyRes.data.success) {
        log.success('Latency metrics retrieved');
      } else if (latencyRes.status === 403) {
        log.warn('Analytics require ADMIN role');
      }
    } catch (error) {
      if (error.response?.status === 403) {
        log.warn('Analytics require ADMIN role (expected)');
      } else {
        log.error(`Failed to get analytics: ${error.message}`);
      }
    }

    // ============================================
    // 11. CONSTANTS ENDPOINT
    // ============================================
    log.test('Constants API');
    try {
      const constantsRes = await axios.get(`${BASE_URL}/constants`);
      if (constantsRes.data.success) {
        log.success('Constants retrieved successfully');
        log.info(`Roles: ${Object.keys(constantsRes.data.data.ROLES).join(', ')}`);
        log.info(`Request Statuses: ${Object.keys(constantsRes.data.data.REQUEST_STATUS).join(', ')}`);
      }
    } catch (error) {
      log.error(`Failed to get constants: ${error.message}`);
    }

    // ============================================
    // 12. EMERGENCY HISTORY
    // ============================================
    log.test('Emergency History');
    try {
      const historyRes = await axios.get(`${BASE_URL}/emergency/history`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      
      if (historyRes.data.success) {
        log.success(`Retrieved ${historyRes.data.data.length} emergency records`);
      }
    } catch (error) {
      log.error(`Failed to get history: ${error.message}`);
    }

    // ============================================
    // 13. RATE LIMITING TEST
    // ============================================
    log.test('Rate Limiting');
    let rateLimitHits = 0;
    for (let i = 0; i < 5; i++) {
      try {
        await axios.get(`${BASE_URL}/constants`);
        rateLimitHits++;
      } catch (error) {
        if (error.response?.status === 429) {
          log.warn(`Rate limit triggered after ${i + 1} requests`);
          break;
        }
      }
    }
    log.success(`Successfully made ${rateLimitHits} requests`);

    // ============================================
    // 14. LOGOUT
    // ============================================
    log.test('Logout');
    try {
      const logoutRes = await axios.post(
        `${BASE_URL}/auth/logout`,
        {},
        { headers: { Authorization: `Bearer ${authToken}` } }
      );
      if (logoutRes.data.success) {
        log.success('Logout successful');
      }
    } catch (error) {
      log.error(`Logout failed: ${error.message}`);
    }

    // ============================================
    // 15. VERIFY TOKEN REVOCATION
    // ============================================
    log.test('Token Revocation');
    try {
      await axios.get(`${BASE_URL}/auth/me`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      log.error('Token should have been revoked');
    } catch (error) {
      if (error.response?.status === 401) {
        log.success('Token correctly revoked');
      }
    }

    // ============================================
    // 16. SOCKET.IO CONNECTION TEST (optional)
    // ============================================
    log.test('Socket.IO Connection');
    try {
      const io = require('socket.io-client');
      const socket = io(BASE_URL.replace('/api', ''), {
        transports: ['websocket'],
        timeout: 5000,
      });
      
      socket.on('connect', () => {
        log.success('Socket.IO connection established');
        socket.disconnect();
      });
      
      socket.on('connect_error', (err) => {
        log.warn(`Socket.IO connection failed: ${err.message}`);
      });
      
      setTimeout(() => {
        if (socket.disconnected) {
          log.warn('Socket.IO connection timeout (may not be critical)');
        }
      }, 3000);
    } catch (error) {
      log.warn(`Socket.IO test skipped: ${error.message}`);
    }

    // ============================================
    // TEST SUMMARY
    // ============================================
    console.log('\n' + '='.repeat(60));
    console.log(`${colors.blue}📊 Test Summary${colors.reset}`);
    console.log('='.repeat(60));
    console.log(`User ID Created: ${testUserId || 'N/A'}`);
    console.log(`Emergency Request ID: ${testRequestId || 'N/A'}`);
    console.log(`Ambulance ID: ${testAmbulanceId || 'N/A'}`);
    console.log('='.repeat(60) + '\n');

  } catch (error) {
    console.error('\n' + '='.repeat(60));
    console.error(`${colors.red}❌ Test Suite Error${colors.reset}`);
    console.error('='.repeat(60));
    console.error(error);
  }
}

// Run tests
testApi();