'use strict';

const logger = require('./logger');
const AuditLog = require('../models/AuditLog');

/**
 * AUDIT LOGGING SYSTEM
 * 
 * Records all critical actions with:
 * - User identification
 * - Action details
 * - Resource information
 * - Change history (before/after)
 * - Timestamp and request ID
 * - IP address and user agent
 * - Outcome (success/failure)
 * 
 * Records application audit events. This research prototype does not claim
 * external compliance certification or cryptographic immutability.
 */

const AUDIT_ACTIONS = {
  // Authentication
  USER_LOGIN: 'USER_LOGIN',
  USER_LOGOUT: 'USER_LOGOUT',
  USER_REGISTRATION: 'USER_REGISTRATION',
  PASSWORD_RESET: 'PASSWORD_RESET',
  PASSWORD_CHANGE: 'PASSWORD_CHANGE',
  TOKEN_REVOKED: 'TOKEN_REVOKED',

  // Emergency Requests
  EMERGENCY_CREATED: 'EMERGENCY_CREATED',
  EMERGENCY_UPDATED: 'EMERGENCY_UPDATED',
  EMERGENCY_CANCELLED: 'EMERGENCY_CANCELLED',
  EMERGENCY_ASSIGNED: 'EMERGENCY_ASSIGNED',
  EMERGENCY_COMPLETED: 'EMERGENCY_COMPLETED',

  // Dispatch Operations
  DISPATCH_ASSIGNED: 'DISPATCH_ASSIGNED',
  DISPATCH_ACCEPTED: 'DISPATCH_ACCEPTED',
  DISPATCH_REJECTED: 'DISPATCH_REJECTED',
  DISPATCH_EN_ROUTE: 'DISPATCH_EN_ROUTE',
  DISPATCH_ARRIVED: 'DISPATCH_ARRIVED',

  // Medical Records
  MEDICAL_RECORD_CREATED: 'MEDICAL_RECORD_CREATED',
  MEDICAL_RECORD_UPDATED: 'MEDICAL_RECORD_UPDATED',
  MEDICAL_RECORD_ACCESSED: 'MEDICAL_RECORD_ACCESSED',
  MEDICAL_RECORD_DELETED: 'MEDICAL_RECORD_DELETED',

  // Hospital Operations
  HOSPITAL_UPDATED: 'HOSPITAL_UPDATED',
  HOSPITAL_BED_ALLOCATED: 'HOSPITAL_BED_ALLOCATED',
  HOSPITAL_BED_RELEASED: 'HOSPITAL_BED_RELEASED',

  // Admin Actions
  USER_CREATED: 'USER_CREATED',
  USER_UPDATED: 'USER_UPDATED',
  USER_DELETED: 'USER_DELETED',
  ROLE_CHANGED: 'ROLE_CHANGED',
  SYSTEM_CONFIG_CHANGED: 'SYSTEM_CONFIG_CHANGED',

  // Security Events
  FAILED_LOGIN_ATTEMPT: 'FAILED_LOGIN_ATTEMPT',
  UNAUTHORIZED_ACCESS_ATTEMPT: 'UNAUTHORIZED_ACCESS_ATTEMPT',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  SUSPICIOUS_ACTIVITY: 'SUSPICIOUS_ACTIVITY',

  // System Events
  SYSTEM_ERROR: 'SYSTEM_ERROR',
  SERVICE_ALERT: 'SERVICE_ALERT',
  BACKUP_STARTED: 'BACKUP_STARTED',
  BACKUP_COMPLETED: 'BACKUP_COMPLETED'
};

/**
 * Log an audit event
 * 
 * Usage:
 * await logAudit({
 *   action: AUDIT_ACTIONS.EMERGENCY_CREATED,
 *   userId: req.user._id,
 *   resourceType: 'EmergencyRequest',
 *   resourceId: emergencyRequest._id,
 *   details: { priority: 'HIGH', type: 'MEDICAL' },
 *   changes: { before: {}, after: emergencyRequest },
 *   status: 'SUCCESS',
 *   req: req
 * });
 */
const logAudit = async (options = {}) => {
  const {
    action,
    userId,
    resourceType,
    resourceId,
    details = {},
    changes = {},
    status = 'SUCCESS',
    error = null,
    req = null,
    severity = 'INFO'
  } = options;

  try {
    const actor = userId || req?.user?._id;
    const auditEntry = new AuditLog({
      action,
      actor,
      userId: actor,
      userRole: req?.user?.role,
      entity: resourceType ? { type: resourceType, id: resourceId } : undefined,
      resourceType,
      resourceId,
      details: maskSensitiveData(details),
      changes: {
        before: maskSensitiveData(changes.before || {}),
        after: maskSensitiveData(changes.after || {})
      },
      status,
      errorMessage: error ? error.message : null,
      severity,
      ipAddress: req?.ip,
      userAgent: req?.get('user-agent'),
      requestId: req?.id || req?.locals?.requestId,
      timestamp: new Date()
    });

    await auditEntry.save();

    // Also log to structured logging system
    logger.info('AUDIT_LOG', {
      action,
      userId,
      userRole: req?.user?.role,
      resourceType,
      resourceId,
      status,
      severity,
      requestId: req?.id || req?.locals?.requestId,
      ipAddress: req?.ip
    });

    return auditEntry;
  } catch (err) {
    logger.error('Failed to log audit event', {
      action,
      error: err.message,
      originalError: error?.message
    });
    throw err;
  }
};

/**
 * Log security-related events
 */
const logSecurityEvent = async (eventType, details, req) => {
  await logAudit({
    action: eventType,
    userId: req?.user?._id,
    details,
    status: 'SECURITY_EVENT',
    severity: 'CRITICAL',
    req
  });
};

/**
 * Log medical data access (for compliance)
 */
const logMedicalAccess = async (userId, recordId, accessType, req) => {
  await logAudit({
    action: AUDIT_ACTIONS.MEDICAL_RECORD_ACCESSED,
    userId,
    resourceType: 'MedicalRecord',
    resourceId: recordId,
    details: { accessType },
    status: 'SUCCESS',
    severity: 'MEDICAL_DATA',
    req
  });
};

/**
 * Mask sensitive data in audit logs
 * Removes passwords, tokens, etc. from logged objects
 */
const maskSensitiveData = (obj) => {
  if (!obj || typeof obj !== 'object') return obj;

  const sensitiveFields = [
    'password',
    'token',
    'jwt',
    'apiKey',
    'secret',
    'credential',
    'authorization'
  ];

  const masked = JSON.parse(JSON.stringify(obj));

  const mask = (o) => {
    Object.keys(o).forEach(key => {
      if (sensitiveFields.some(field => key.toLowerCase().includes(field))) {
        o[key] = '***REDACTED***';
      } else if (typeof o[key] === 'object' && o[key] !== null) {
        mask(o[key]);
      }
    });
  };

  mask(masked);
  return masked;
};

/**
 * Query audit logs with filtering
 */
const queryAuditLogs = async (filters = {}) => {
  const {
    action,
    userId,
    resourceType,
    resourceId,
    startDate,
    endDate,
    limit = 100,
    skip = 0
  } = filters;

  const query = {};

  if (action) query.action = action;
  if (userId) query.userId = userId;
  if (resourceType) query.resourceType = resourceType;
  if (resourceId) query.resourceId = resourceId;
  if (startDate || endDate) {
    query.timestamp = {};
    if (startDate) query.timestamp.$gte = startDate;
    if (endDate) query.timestamp.$lte = endDate;
  }

  return AuditLog.find(query)
    .limit(limit)
    .skip(skip)
    .sort({ timestamp: -1 });
};

/**
 * Generate audit report for compliance
 */
const generateAuditReport = async (startDate, endDate) => {
  const logs = await queryAuditLogs({
    startDate,
    endDate,
    limit: 10000
  });

  const report = {
    generatedAt: new Date(),
    period: { startDate, endDate },
    summary: {
      totalEvents: logs.length,
      byAction: {},
      byUser: {},
      byStatus: {},
      failures: []
    },
    criticalEvents: []
  };

  logs.forEach(log => {
    // Count by action
    report.summary.byAction[log.action] = (report.summary.byAction[log.action] || 0) + 1;

    // Count by user
    const userId = String(log.userId || 'SYSTEM');
    report.summary.byUser[userId] = (report.summary.byUser[userId] || 0) + 1;

    // Count by status
    report.summary.byStatus[log.status] = (report.summary.byStatus[log.status] || 0) + 1;

    // Collect failures
    if (log.status === 'FAILURE' || log.status === 'ERROR') {
      report.summary.failures.push({
        timestamp: log.timestamp,
        action: log.action,
        error: log.errorMessage
      });
    }

    // Collect critical events
    if (log.severity === 'CRITICAL' || log.severity === 'MEDICAL_DATA') {
      report.criticalEvents.push({
        timestamp: log.timestamp,
        action: log.action,
        userId: log.userId,
        resourceType: log.resourceType,
        resourceId: log.resourceId,
        ipAddress: log.ipAddress
      });
    }
  });

  return report;
};

/**
 * Detect suspicious patterns in audit logs
 */
const detectSuspiciousActivity = async (userId, timeWindowMs = 3600000) => {
  const timeThreshold = new Date(Date.now() - timeWindowMs);

  const recentLogs = await AuditLog.find({
    userId,
    timestamp: { $gte: timeThreshold }
  });

  const suspiciousPatterns = [];

  // Multiple failed login attempts
  const failedLogins = recentLogs.filter(l => l.action === 'FAILED_LOGIN_ATTEMPT');
  if (failedLogins.length > 5) {
    suspiciousPatterns.push({
      pattern: 'BRUTE_FORCE_ATTEMPT',
      count: failedLogins.length,
      description: `${failedLogins.length} failed login attempts in ${timeWindowMs / 1000 / 60} minutes`
    });
  }

  // Rapid unauthorized access attempts
  const unauthorizedAttempts = recentLogs.filter(l => l.action === 'UNAUTHORIZED_ACCESS_ATTEMPT');
  if (unauthorizedAttempts.length > 10) {
    suspiciousPatterns.push({
      pattern: 'REPEATED_UNAUTHORIZED_ACCESS',
      count: unauthorizedAttempts.length,
      description: `${unauthorizedAttempts.length} unauthorized access attempts`
    });
  }

  // Unusual access patterns (e.g., accessing many resources rapidly)
  const resourceAccess = {};
  recentLogs.forEach(log => {
    if (log.resourceType) {
      resourceAccess[log.resourceType] = (resourceAccess[log.resourceType] || 0) + 1;
    }
  });

  const unusualAccess = Object.entries(resourceAccess)
    .filter(([_, count]) => count > 50)
    .map(([type, count]) => ({
      pattern: 'UNUSUAL_VOLUME_ACCESS',
      resourceType: type,
      count,
      description: `Accessed ${type} ${count} times in ${timeWindowMs / 1000 / 60} minutes`
    }));

  suspiciousPatterns.push(...unusualAccess);

  return suspiciousPatterns;
};

module.exports = {
  logAudit,
  logSecurityEvent,
  logMedicalAccess,
  queryAuditLogs,
  generateAuditReport,
  detectSuspiciousActivity,
  maskSensitiveData,
  AUDIT_ACTIONS
};
