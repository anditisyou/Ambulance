// scripts/load-test.js
/**
 * Load Testing Strategy for Emergency Response System
 * Simulates 1000 concurrent users with realistic emergency scenarios
 *
 * Usage:
 * node scripts/load-test.js [duration_seconds] [max_users]
 *
 * Example:
 * node scripts/load-test.js 300 1000  # 5 minutes with 1000 users
 */

const axios = require('axios');
const { Worker } = require('worker_threads');
const path = require('path');
const fs = require('fs');

const BASE_URL = process.env.TEST_API_URL || 'http://localhost:3000/api';
const DURATION = parseInt(process.argv[2]) || 300; // 5 minutes default
const MAX_USERS = parseInt(process.argv[3]) || 1000; // 1000 users default

class LoadTester {
  constructor() {
    this.startTime = Date.now();
    this.endTime = this.startTime + (DURATION * 1000);
    this.workers = [];
    this.stats = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      responseTimes: [],
      errors: {},
      usersCreated: 0,
      emergenciesCreated: 0,
      throughput: 0,
    };

    this.userTokens = [];
    this.emergencyIds = [];
  }

  log(message, data = null) {
    const timestamp = new Date().toISOString();
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
    console.log(`[${timestamp}] [${elapsed}s] ${message}`);
    if (data) console.log(JSON.stringify(data, null, 2));
  }

  async createTestUsers(count = 100) {
    this.log(`Creating ${count} test users...`);

    const createPromises = [];
    for (let i = 0; i < count; i++) {
      const userData = {
        name: `LoadTest_User_${i}_${Date.now()}`,
        email: `loadtest${i}_${Date.now()}@test.com`,
        phone: `+1${Math.floor(Math.random() * 9000000000) + 1000000000}`,
        password: 'Test@1234',
        role: Math.random() > 0.8 ? 'HOSPITAL' : 'CITIZEN', // 20% hospitals
      };

      createPromises.push(
        axios.post(`${BASE_URL}/auth/register`, userData)
          .then(response => {
            if (response.data.success) {
              this.stats.usersCreated++;
              return response.data.token;
            }
          })
          .catch(() => null) // Ignore registration failures
      );
    }

    const tokens = await Promise.all(createPromises);
    this.userTokens = tokens.filter(token => token);
    this.log(`Created ${this.userTokens.length} test users`);
  }

  async runWorker(workerId) {
    const worker = new Worker(path.join(__dirname, 'load-test-worker.js'), {
      workerData: {
        workerId,
        baseUrl: BASE_URL,
        userTokens: this.userTokens,
        duration: DURATION,
        endTime: this.endTime,
      }
    });

    return new Promise((resolve) => {
      worker.on('message', (message) => {
        if (message.type === 'stats') {
          // Aggregate stats from worker
          this.stats.totalRequests += message.stats.requests;
          this.stats.successfulRequests += message.stats.successful;
          this.stats.failedRequests += message.stats.failed;
          this.stats.responseTimes.push(...message.stats.responseTimes);
          this.stats.emergenciesCreated += message.stats.emergenciesCreated || 0;

          // Aggregate errors
          Object.keys(message.stats.errors).forEach(error => {
            this.stats.errors[error] = (this.stats.errors[error] || 0) + message.stats.errors[error];
          });
        }
      });

      worker.on('exit', () => {
        resolve();
      });
    });
  }

  calculateStats() {
    const totalTime = (Date.now() - this.startTime) / 1000;
    const totalRequests = this.stats.totalRequests;
    const successfulRequests = this.stats.successfulRequests;
    const failedRequests = this.stats.failedRequests;

    // Calculate percentiles
    const sortedTimes = this.stats.responseTimes.sort((a, b) => a - b);
    const p50 = sortedTimes[Math.floor(sortedTimes.length * 0.5)] || 0;
    const p95 = sortedTimes[Math.floor(sortedTimes.length * 0.95)] || 0;
    const p99 = sortedTimes[Math.floor(sortedTimes.length * 0.99)] || 0;

    return {
      duration: totalTime,
      totalRequests,
      successfulRequests,
      failedRequests,
      successRate: totalRequests > 0 ? (successfulRequests / totalRequests * 100).toFixed(2) : 0,
      throughput: (totalRequests / totalTime).toFixed(2), // requests per second
      avgResponseTime: sortedTimes.length > 0 ? (sortedTimes.reduce((a, b) => a + b, 0) / sortedTimes.length).toFixed(2) : 0,
      p50ResponseTime: p50.toFixed(2),
      p95ResponseTime: p95.toFixed(2),
      p99ResponseTime: p99.toFixed(2),
      usersCreated: this.stats.usersCreated,
      emergenciesCreated: this.stats.emergenciesCreated,
      topErrors: Object.entries(this.stats.errors)
        .sort(([,a], [,b]) => b - a)
        .slice(0, 5)
        .map(([error, count]) => ({ error, count })),
    };
  }

  async run() {
    this.log(`🚀 Starting load test: ${MAX_USERS} users for ${DURATION} seconds`);
    this.log(`Target URL: ${BASE_URL}`);

    // Phase 1: Create test users
    await this.createTestUsers(Math.min(200, MAX_USERS)); // Create up to 200 users

    // Phase 2: Start load testing workers
    this.log(`Starting ${Math.min(10, MAX_USERS / 10)} worker threads...`);

    const numWorkers = Math.min(10, Math.ceil(MAX_USERS / 100)); // Max 10 workers
    const workerPromises = [];

    for (let i = 0; i < numWorkers; i++) {
      workerPromises.push(this.runWorker(i));
    }

    // Wait for all workers to complete
    await Promise.all(workerPromises);

    // Phase 3: Calculate and display results
    const finalStats = this.calculateStats();

    this.log('📊 Load Test Results:', finalStats);

    // Save results to file
    const resultsFile = `load-test-results-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    fs.writeFileSync(resultsFile, JSON.stringify({
      timestamp: new Date().toISOString(),
      config: { duration: DURATION, maxUsers: MAX_USERS, baseUrl: BASE_URL },
      results: finalStats,
    }, null, 2));

    this.log(`📄 Results saved to ${resultsFile}`);

    // Check if system passed load test
    const passed = finalStats.successRate >= 95 && finalStats.p95ResponseTime < 5000;
    this.log(passed ? '✅ Load test PASSED' : '❌ Load test FAILED');

    process.exit(passed ? 0 : 1);
  }
}

// Run the load test
if (require.main === module) {
  const tester = new LoadTester();
  tester.run().catch(error => {
    console.error('Load test failed:', error);
    process.exit(1);
  });
}

module.exports = LoadTester;