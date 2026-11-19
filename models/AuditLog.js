'use strict';

const mongoose = require('mongoose');
const logger = require('../utils/logger');

// Audit records are append-only by application convention. MongoDB alone does
// not make them tamper-proof, so this model deliberately makes no immutability
// or cryptographic-integrity claim.
const auditLogSchema = new mongoose.Schema({
  action: { type: String, required: true, index: true },
  entity: {
    type: { type: String, index: true },
    id: mongoose.Schema.Types.ObjectId,
  },
  actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  changes: { type: mongoose.Schema.Types.Mixed, default: {} },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  userRole: String,
  resourceType: String,
  resourceId: mongoose.Schema.Types.ObjectId,
  details: mongoose.Schema.Types.Mixed,
  status: String,
  errorMessage: String,
  severity: String,
  ipAddress: String,
  userAgent: String,
  requestId: String,
  reason: String,
  timestamp: { type: Date, default: Date.now, index: true },
}, { collection: 'auditLogs', strict: 'throw' });

auditLogSchema.index({ 'entity.id': 1, timestamp: -1 });
auditLogSchema.index({ action: 1, timestamp: -1 });

const AuditLog = mongoose.model('AuditLog', auditLogSchema);

class AuditLogger {
  static async log(actionOrEvent, entity, actor, changes = {}, metadata = {}) {
    const event = typeof actionOrEvent === 'object'
      ? actionOrEvent
      : { action: actionOrEvent, entity, actor, changes, metadata };

    const auditEntry = new AuditLog({
      action: event.action,
      entity: event.entity,
      actor: event.actor || event.userId,
      userId: event.userId || event.actor,
      changes: event.changes || {},
      metadata: event.metadata || {},
      details: event.details,
      status: event.status || 'SUCCESS',
      severity: event.severity || 'INFO',
      requestId: event.requestId,
      ipAddress: event.ipAddress,
      userAgent: event.userAgent,
      reason: event.reason,
      errorMessage: event.errorMessage,
    });

    try {
      await auditEntry.save();
      logger.info('Audit log recorded', { action: auditEntry.action, entityId: auditEntry.entity?.id, actorId: auditEntry.actor });
      return auditEntry;
    } catch (error) {
      logger.error('Failed to record audit log', { action: event.action, error: error.message });
      throw error;
    }
  }
}

module.exports = AuditLog;
module.exports.AuditLog = AuditLog;
module.exports.AuditLogger = AuditLogger;
