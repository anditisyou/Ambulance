process.env.NODE_ENV = 'test';

// Avoid hitting external Redis during unit tests unless explicitly requested.
if (!process.env.USE_REAL_REDIS_IN_TESTS) {
  delete process.env.REDIS_URL;
  delete process.env.REDIS_HOST;
  delete process.env.REDIS_PORT;
  delete process.env.REDIS_PASSWORD;
}
