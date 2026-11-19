'use strict';

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { encrypt, decrypt, getEncryptionKey } = require('../utils/encryption');
const EmergencyRequest = require('../models/EmergencyRequest');
const MedicalRecord = require('../models/MedicalRecord');
const AuditLog = require('../models/AuditLog');
const { logAudit, AUDIT_ACTIONS } = require('../utils/auditLog');
const retentionSingleton = require('../utils/dataRetentionManager');

jest.setTimeout(30000);

let mongoServer;

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = 'a'.repeat(64);
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
});

afterEach(async () => {
  await Promise.all(Object.values(mongoose.connection.collections).map((collection) => collection.deleteMany({})));
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
});

const requestData = () => ({
  userId: new mongoose.Types.ObjectId(),
  userName: 'Test Citizen',
  userPhone: '+15555550100',
  location: { type: 'Point', coordinates: [-118.2437, 34.0522] },
  allergies: 'Penicillin',
  vitals: { heartRate: 112, bloodPressure: '140/90' },
  triageNotes: 'Immediate assessment required',
  medicalHistorySummary: 'Asthma',
});

describe('sensitive clinical data protection', () => {
  test('encrypts and decrypts clinical emergency fields without storing plaintext', async () => {
    const request = await EmergencyRequest.create(requestData());
    const raw = await EmergencyRequest.collection.findOne({ _id: request._id });

    expect(JSON.stringify(raw)).not.toContain('Penicillin');
    expect(raw.encryptedClinicalData.ciphertext).toBeDefined();

    const loaded = await EmergencyRequest.findById(request._id).select('+encryptedClinicalData');
    expect(loaded.getDecryptedClinicalData()).toMatchObject({
      allergies: 'Penicillin',
      vitals: { heartRate: 112, bloodPressure: '140/90' },
    });
  });

  test('encrypts free-form medical-record data and decrypts it correctly', async () => {
    const record = await MedicalRecord.create({
      userId: new mongoose.Types.ObjectId(),
      recordType: 'note',
      data: { diagnosis: 'Asthma exacerbation', medications: ['albuterol'] },
    });
    const raw = await MedicalRecord.collection.findOne({ _id: record._id });
    expect(JSON.stringify(raw)).not.toContain('Asthma exacerbation');

    const loaded = await MedicalRecord.findById(record._id).select('+encryptedData');
    expect(loaded.getDecryptedData()).toEqual({ diagnosis: 'Asthma exacerbation', medications: ['albuterol'] });
  });

  test('rejects a missing production encryption key', () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousKey = process.env.ENCRYPTION_KEY;
    process.env.NODE_ENV = 'production';
    delete process.env.ENCRYPTION_KEY;

    expect(() => getEncryptionKey()).toThrow(/ENCRYPTION_KEY/);

    process.env.NODE_ENV = previousNodeEnv;
    process.env.ENCRYPTION_KEY = previousKey;
  });
});

describe('audit and retention behavior', () => {
  test('writes a schema-valid audit record with actor, entity, context and request metadata', async () => {
    const actor = new mongoose.Types.ObjectId();
    const entityId = new mongoose.Types.ObjectId();
    const entry = await logAudit({
      action: AUDIT_ACTIONS.EMERGENCY_CREATED,
      userId: actor,
      resourceType: 'EmergencyRequest',
      resourceId: entityId,
      changes: { after: { status: 'PENDING' } },
      metadata: { correlationId: 'request-123', source: 'test' },
      severity: 'INFO',
      req: { ip: '127.0.0.1', get: () => 'Jest', locals: { requestId: 'request-123' } },
    });

    expect(entry._id).toBeDefined();
    const stored = await AuditLog.findById(entry._id).lean();
    expect(stored.actor.toString()).toBe(actor.toString());
    expect(stored.entity).toMatchObject({ type: 'EmergencyRequest', id: entityId });
    expect(stored.requestId).toBe('request-123');
    expect(stored.ipAddress).toBe('127.0.0.1');
  });

  test('cleans configured orphaned Redis keys and safely handles an empty prefix configuration', async () => {
    const redisClient = {
      keys: jest.fn().mockResolvedValue(['temp:orphan', 'temp:valid']),
      ttl: jest.fn().mockImplementation(async (key) => key === 'temp:orphan' ? -1 : 60),
      del: jest.fn().mockResolvedValue(1),
    };
    const manager = new retentionSingleton.DataRetentionManager({ redisClient });
    const del = redisClient.del;
    manager.config.redisTempPrefixes = ['temp:'];

    await expect(manager._cleanupTemporaryRedisKeys()).resolves.toEqual({ scanned: 2, removed: 1, failures: [] });
    expect(del).toHaveBeenCalledWith('temp:orphan');

    manager.config.redisTempPrefixes = [];
    await expect(manager._cleanupTemporaryRedisKeys()).resolves.toEqual({ scanned: 0, removed: 0, failures: [] });
  });

  test('marks old completed requests as logically archived without claiming external archival', async () => {
    const manager = new retentionSingleton.DataRetentionManager();
    manager.config.requestArchiveAfterDays = 1;
    const request = await EmergencyRequest.create({
      ...requestData(),
      status: 'COMPLETED',
      assignmentState: 'COMPLETED',
      completionTime: new Date(Date.now() - 2 * 86400000),
    });

    await manager._archiveOldRequests();
    const stored = await EmergencyRequest.findById(request._id).lean();
    expect(stored.logicalArchived).toBe(true);
    expect(stored.logicalArchivedAt).toBeDefined();
    expect(stored.archived).toBeUndefined();
  });
});
