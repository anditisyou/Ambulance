'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const { server } = require('./server');

const PORT = process.env.PORT || 3000;

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
  });
}

module.exports = { server };