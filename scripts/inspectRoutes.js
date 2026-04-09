require('dotenv').config();
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecret';
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/test';
const { expressApp } = require('../server');
const routes = expressApp._router.stack
  .filter(layer => layer.route)
  .map(layer => ({ path: layer.route.path, methods: Object.keys(layer.route.methods).join(',').toUpperCase() }))
  .sort((a, b) => a.path.localeCompare(b.path));
console.log(JSON.stringify(routes, null, 2));
