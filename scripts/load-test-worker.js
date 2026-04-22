// scripts/load-test-worker.js
/**
 * Load Test Worker - Simulates realistic user behavior
 */

const { parentPort, workerData } = require('worker_threads');
const axios = require('axios');

const { workerId, baseUrl, userTokens, duration, endTime } = workerData;

class LoadTestWorker {
  constructor() {
    this.stats = {
      requests: 0,
      successful: 0,
      failed: 0,
      responseTimes: [],
      errors: {},
      emergenciesCreated: 0,
    };

    this.sessionTokens = new Map(); // userId -> token
  }

  recordRequest(responseTime, success = true, error = null) {
    this.stats.requests++;
    if (success) {
      this.stats.successful++;
    } else {
      this.stats.failed++;
      if (error) {
        const errorKey = error.code || error.message || 'Unknown';
        this.stats.errors[errorKey] = (this.stats.errors[errorKey] || 0) + 1;
      }
    }
    this.stats.responseTimes.push(responseTime);
  }

  async makeRequest(method, url, data = null, token = null) {
    const startTime = Date.now();
    const config = {
      method,
      url,
      timeout: 30000, // 30 second timeout
      headers: {},
    };

    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }

    if (data) {
      config.data = data;
      config.headers['Content-Type'] = 'application/json';
    }

    try {
      const response = await axios(config);
      const responseTime = Date.now() - startTime;
      this.recordRequest(responseTime, true);
      return response.data;
    } catch (error) {
      const responseTime = Date.now() - startTime;
      this.recordRequest(responseTime, false, error);
      throw error;
    }
  }

  getRandomToken() {
    if (userTokens.length === 0) return null;
    return userTokens[Math.floor(Math.random() * userTokens.length)];
  }

  async simulateUserJourney() {
    const token = this.getRandomToken();
    if (!token) return;

    try {
      // 1. Get user profile (simulate dashboard load)
      await this.makeRequest('GET', `${baseUrl}/auth/profile`, null, token);

      // 2. 30% chance to create emergency request
      if (Math.random() < 0.3) {
        const emergencyData = {
          location: {
            type: 'Point',
            coordinates: [
              -118.2437 + (Math.random() - 0.5) * 0.1, // Random LA coordinates
              34.0522 + (Math.random() - 0.5) * 0.1
            ]
          },
          priority: Math.random() > 0.7 ? 'HIGH' : 'MEDIUM',
          description: 'Load test emergency request',
          phone: '+1234567890',
          medicalInfo: 'Simulated medical emergency for load testing'
        };

        const response = await this.makeRequest('POST', `${baseUrl}/emergency`, emergencyData, token);
        if (response.success) {
          this.stats.emergenciesCreated++;
        }
      }

      // 3. 20% chance to check emergency status
      if (Math.random() < 0.2) {
        await this.makeRequest('GET', `${baseUrl}/emergency`, null, token);
      }

      // 4. 10% chance to access analytics (admin/hospital users)
      if (Math.random() < 0.1) {
        await this.makeRequest('GET', `${baseUrl}/analytics/dashboard`, null, token);
      }

      // 5. Always check health endpoint
      await this.makeRequest('GET', `${baseUrl.replace('/api', '')}/health`);

    } catch (error) {
      // Errors are already recorded in makeRequest
    }
  }

  async simulateHospitalJourney() {
    const token = this.getRandomToken();
    if (!token) return;

    try {
      // Hospital-specific actions
      await this.makeRequest('GET', `${baseUrl}/hospitals/dashboard`, null, token);

      if (Math.random() < 0.5) {
        await this.makeRequest('GET', `${baseUrl}/emergency/pending`, null, token);
      }

      if (Math.random() < 0.3) {
        await this.makeRequest('GET', `${baseUrl}/analytics/hospital`, null, token);
      }

    } catch (error) {
      // Errors recorded in makeRequest
    }
  }

  async run() {
    const startTime = Date.now();

    while (Date.now() < endTime) {
      // Emergency spike simulation: 5% chance to create multiple emergencies simultaneously
      if (Math.random() < 0.05) {
        await this.simulateEmergencySpike();
      } else {
        // Simulate different user types
        const userType = Math.random();

        if (userType < 0.7) {
          // 70% regular users
          await this.simulateUserJourney();
        } else {
          // 30% hospital users
          await this.simulateHospitalJourney();
        }
      }

      // Random delay between 100ms - 2s to simulate realistic user behavior
      const delay = 100 + Math.random() * 1900;
      await new Promise(resolve => setTimeout(resolve, delay));
    }

    const duration = (Date.now() - startTime) / 1000;
    this.stats.throughput = this.stats.requests / duration;

    // Send final stats to parent
    parentPort.postMessage({
      type: 'stats',
      workerId,
      stats: this.stats,
    });
  }

  async simulateEmergencySpike() {
    // Simulate 3-8 simultaneous emergencies (like a multi-car accident)
    const spikeCount = 3 + Math.floor(Math.random() * 6);

    this.log(`🚨 Emergency spike: ${spikeCount} simultaneous emergencies`);

    const spikePromises = [];
    for (let i = 0; i < spikeCount; i++) {
      spikePromises.push(this.createEmergencyRequest());
    }

    await Promise.allSettled(spikePromises);
  }

  async createEmergencyRequest() {
    const token = this.getRandomToken();
    if (!token) return;

    try {
      // Create emergency in a concentrated geographic area (simulating incident location)
      const baseLat = 34.0522 + (Math.random() - 0.5) * 0.01; // Small geographic cluster
      const baseLng = -118.2437 + (Math.random() - 0.5) * 0.01;

      const emergencyData = {
        location: {
          type: 'Point',
          coordinates: [
            baseLng + (Math.random() - 0.5) * 0.002, // Within 200m of incident
            baseLat + (Math.random() - 0.5) * 0.002
          ]
        },
        priority: Math.random() > 0.5 ? 'CRITICAL' : 'HIGH', // Higher priority for spikes
        description: 'Emergency spike - simulated incident',
        phone: '+1234567890',
        medicalInfo: 'Multiple casualty incident - load test simulation'
      };

      const response = await this.makeRequest('POST', `${baseUrl}/emergency`, emergencyData, token);
      if (response.success) {
        this.stats.emergenciesCreated++;
      }
    } catch (error) {
      // Errors recorded in makeRequest
    }
  }
}

// Start the worker
const worker = new LoadTestWorker();
worker.run().then(() => {
  process.exit(0);
}).catch(error => {
  console.error(`Worker ${workerId} error:`, error);
  process.exit(1);
});