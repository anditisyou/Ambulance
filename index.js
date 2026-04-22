// jai jaaganath
'use strict';

require('dotenv').config();
const { server, waitForMongoConnection } = require('./server');

const PORT = process.env.PORT || 3000;

if (require.main === module) {
  (async () => {
    await waitForMongoConnection;
    server.listen(PORT, () => {
      console.log(`🚀 Server running on http://localhost:${PORT}`);
    });
  })().catch((err) => {
    console.error('Failed to start server:', err);
  });
}

module.exports = { server };