'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'medical-file-test-secret';
process.env.JWT_EXPIRE = '1h';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'medical-file-session-secret';
process.env.CLOUDINARY_CLOUD_NAME = 'ers-test-cloud';
process.env.CLOUDINARY_API_KEY = 'ers-test-key';
process.env.CLOUDINARY_API_SECRET = 'ers-test-secret';

const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const request = require('supertest');
const { MongoMemoryServer } = require('mongodb-memory-server');

const medicalRoutes = require('../../routes/medicalRoutes');
const errorHandler = require('../../middleware/errorHandler');
const User = require('../../models/User');
const MedicalRecord = require('../../models/MedicalRecord');
const { ROLES } = require('../../utils/constants');

let mongoServer;
let app;

const makeApp = () => {
  const instance = express();
  instance.use(express.json());
  instance.use(cookieParser());
  instance.use('/api/medical', medicalRoutes);
  instance.use(errorHandler);
  return instance;
};

const createUser = (role, suffix) =>
  User.create({
    name: `${role} ${suffix}`,
    email: `${role.toLowerCase()}-${suffix}@example.com`,
    phone: `+1555${String(Math.floor(Math.random() * 9000000) + 1000000)}`,
    role,
    password: 'Secure@Pass1',
  });

const authCookie = (user) => {
  const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '1h' });
  return [`token=${token}`];
};

describe('Medical file access', () => {
  let owner;
  let hospital;
  let unrelated;
  let record;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    app = makeApp();
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await Promise.all(Object.values(mongoose.connection.collections).map((col) => col.deleteMany({})));

    owner = await createUser(ROLES.CITIZEN, 'owner');
    hospital = await createUser(ROLES.HOSPITAL, 'hospital');
    unrelated = await createUser(ROLES.CITIZEN, 'unrelated');

    record = await MedicalRecord.create({
      userId: owner._id,
      recordType: 'image',
      fileUrl: 'https://res.cloudinary.com/ers-test-cloud/image/upload/v1/permanent-file.jpg',
      filePublicId: `medical-records/${owner._id}/test-file`,
      fileName: 'test-file.jpg',
      fileType: 'image',
      mimeType: 'image/jpeg',
      sharedWith: [{
        hospitalId: hospital._id,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        accessToken: 'share-token',
      }],
    });
  });

  it('allows an authorized owner to access a medical file through an ERS-authorized signed URL', async () => {
    const metadata = await request(app)
      .get(`/api/medical/record/${record._id}`)
      .set('Cookie', authCookie(owner));

    expect(metadata.status).toBe(200);
    expect(metadata.body.data.viewUrl).toBe(`/api/medical/record/${record._id}/view`);
    expect(metadata.body.data.fileUrl).toBeUndefined();

    const res = await request(app)
      .get(`/api/medical/record/${record._id}/view`)
      .set('Cookie', authCookie(owner));

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('https://res.cloudinary.com/ers-test-cloud/image/authenticated/');
    expect(res.headers.location).toContain('/s--');
    expect(res.headers.location).not.toBe(record.fileUrl);
  });

  it('requires authentication before medical-file access', async () => {
    const res = await request(app).get(`/api/medical/record/${record._id}/view`);

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('rejects access by an unrelated user', async () => {
    const res = await request(app)
      .get(`/api/medical/record/${record._id}/view`)
      .set('Cookie', authCookie(unrelated));

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it('returns 400 for an invalid medical record id', async () => {
    const res = await request(app)
      .get('/api/medical/record/not-a-valid-id/view')
      .set('Cookie', authCookie(owner));

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('returns 404 for a nonexistent medical record', async () => {
    const missingId = new mongoose.Types.ObjectId();
    const res = await request(app)
      .get(`/api/medical/record/${missingId}/view`)
      .set('Cookie', authCookie(owner));

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });
});
