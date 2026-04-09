require('dotenv').config();
const mongoose = require('mongoose');
const Ambulance = require('../models/Ambulance');
const EmergencyRequest = require('../models/EmergencyRequest');
(async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
    const ambs = await Ambulance.find().lean();
    console.log('AMBULANCES:', ambs.map(a => ({
      _id: a._id.toString(),
      driverId: a.driverId?._id ? a.driverId._id.toString() : a.driverId?.toString(),
      status: a.status,
      coords: a.currentLocation?.coordinates,
      type: a.currentLocation?.type,
    })));
    const reqs = await EmergencyRequest.find().sort({ createdAt: -1 }).limit(20).lean();
    console.log('REQUESTS:', reqs.map(r => ({
      _id: r._id.toString(),
      status: r.status,
      assignedAmbulanceId: r.assignedAmbulanceId?.toString(),
      location: r.location?.coordinates,
      userId: r.userId?.toString(),
      requestTime: r.requestTime,
      priority: r.priority,
    })));
  } catch (err) {
    console.error('DB inspect error', err);
  } finally {
    await mongoose.disconnect();
  }
})();
