'use strict';

const mongoose = require('mongoose');
const EmergencyRequest = require('../models/EmergencyRequest');
const Hospital = require('../models/Hospital');
const logger = require('../utils/logger');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/ers';

const migrate = async () => {
  await mongoose.connect(MONGODB_URI, {
    serverSelectionTimeoutMS: 5000,
  });

  logger.info('Connected to MongoDB for migration');

  const defaultValues = {
    allergies: '',
    vitals: {},
    triageNotes: '',
    medicalHistorySummary: '',
  };

  const result = await EmergencyRequest.updateMany(
    {
      $or: [
        { allergies: { $exists: false } },
        { vitals: { $exists: false } },
        { triageNotes: { $exists: false } },
        { medicalHistorySummary: { $exists: false } },
      ],
    },
    {
      $set: defaultValues,
    }
  );

  logger.info(`Updated ${result.modifiedCount || result.nModified || 0} emergency request documents`);

  const hospitals = await Hospital.find();
  for (const hospital of hospitals) {
    hospital.updateCapacityStatus();
    await hospital.save();
  }

  logger.info(`Updated ${hospitals.length} hospital capacity statuses`);

  await mongoose.disconnect();
  logger.info('Migration complete');
};

migrate().catch((err) => {
  logger.error('Migration failed', err);
  process.exit(1);
});
