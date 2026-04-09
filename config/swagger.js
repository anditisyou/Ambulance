const swaggerJSDoc = require('swagger-jsdoc');

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'ERS API',
      version: '1.0.0',
      description: 'Emergency Response System API'
    }
  },
  apis: ['./routes/**/*.js']
};

const swaggerSpec = swaggerJSDoc(options);

module.exports = swaggerSpec;