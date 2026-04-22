'use strict';

const mongoose = require('mongoose');
const logger = require('../utils/logger');

/**
 * Audit Log Schema
 * Immutable audit trail for critical actions
 */

const auditLogSchema = new mongoose.Schema(
  {
    action: {
      type: String,
      enum: [
        'REQUEST_CREATED',
        'REQUEST_ASSIGNED',
        'REQUEST_ACCEPTED',
        'REQUEST_REJECTED',
        'REQUEST_EN_ROUTE',
        'REQUEST_COMPLETED',
        'REQUEST_CANCELLED',
        'AMBULANCE_ALLOCATED',
        'AMBULANCE_REASSIGNED',
        'HOSPITAL_ASSIGNED',
        'SLA_BREACHED',
        'TIMEOUT_TRIGGERED',
      ],
      index: true,
    },
    entity: {
      type: {
        type: String, // 'REQUEST', 'AMBULANCE', 'HOSPITAL', etc.
        enum: ['REQUEST', 'AMBULANCE', 'HOSPITAL', 'DRIVER', 'SYSTEM'],
        index: true,
      },
      id: mongoose.Schema.Types.ObjectId,
    },
    actor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    changes: {
      before: Object,
      after: Object,
    },
    reason: String, // Why this action was taken
    metadata: {
      correlationId: String, // Link related events
      ipAddress: String,
      userAgent: String,
      slaStatus: String,
      priority: String,
    },
    timestamp: {
      type: Date,
      default: Date.now,
      index: true,
    },
    immutableHash: String, // Hash of record for tamper detection
  },
  { collection: 'auditLogs', strict: 'throw' }
);

// Compound indexes for common queries
auditLogSchema.index({ 'entity.id': 1, timestamp: -1 });
auditLogSchema.index({ action: 1, timestamp: -1 });
auditLogSchema.index({ actor: 1, timestamp: -1 });

// Prevent updates/deletes on audit logs
auditLogSchema.pre('updateOne', function (next) {
  next(new Error('Audit logs are immutable'));
});

auditLogSchema.pre('findByIdAndUpdate', function (next) {
  next(new Error('Audit logs are immutable'));
});

auditLogSchema.pre('deleteOne', function (next) {
  next(new Error('Audit logs cannot be deleted'));
});

const AuditLog = mongoose.model('AuditLog', auditLogSchema);

/**
 * Audit Logger Service
 * Records all critical actions for compliance
 */

class AuditLogger {
  static async log(action, entity, actor, changes = {}, metadata = {}) {
    try {
      const auditEntry = new AuditLog({
        action,
        entity,
        actor,
        changes,
        metadata: {
          ...metadata,
          timestamp: new Date().toISOString(),
        },
      });

      await auditEntry.save();
      logger.info('Audit log recorded', {
        action,
        entityId: entity.id,
        actorId: actor,
      });

      return auditEntry;
    } catch (err) {
      logger.error('Failed to record audit log', {
        error: err.message,
        action,
      });
      // Don't throw - audit failures shouldn't block operations
      return null;
    }
  }

  static async getAllForEntity(entityId) {
    try {
      return await AuditLog.find({ 'entity.id': entityId })
        .sort({ timestamp: -1 })
        .populate('actor', 'name email role')
        .lean();
    } catch (err) {
      logger.error('Failed to retrieve audit logs', err.message);
      return [];
    }
  }

  static async getActionTrail(action, timeWindow = 24 * 60 * 60 * 1000) {
    try {
      const since = new Date(Date.now() - timeWindow);
      return await AuditLog.find({
        action,
        timestamp: { $gte: since },
      })
        .sort({ timestamp: -1 })
        .lean();
    } catch (err) {
      logger.error('Failed to retrieve action trail', err.message);
      return [];
    }
  }

  static async getComplianceReport(startDate, endDate) {
    try {
      const logs = await AuditLog.find({
        timestamp: { $gte: startDate, $lte: endDate },
      })
        .lean()
        .sort({ timestamp: 1 });

      const report = {
        period: { start: startDate, end: endDate },
        totalActions: logs.length,
        actionsByType: {},
        actorSummary: {},
        criticalEvents: [],
      };

      logs.forEach(log => {
        report.actionsByType[log.action] = (report.actionsByType[log.action] || 0) + 1;
        report.actorSummary[log.actor] = (report.actorSummary[log.actor] || 0) + 1;

        if (['REQUEST_REJECTED', 'SLA_BREACHED', 'TIMEOUT_TRIGGERED'].includes(log.action)) {
          report.criticalEvents.push({
            action: log.action,
            entity: log.entity,
            timestamp: log.timestamp,
          });
        }
      });

      return report;
    } catch (err) {
      logger.error('Failed to generate compliance report', err.message);
      return null;
    }
  }
}

module.exports = { AuditLog, AuditLogger };