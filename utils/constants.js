'use strict';

/**
 * Application-wide constants.
 * SINGLE SOURCE OF TRUTH — never hard-code status strings elsewhere.
 */

// ─── User roles ──────────────────────────────────────────────────────────────
const ROLES = Object.freeze({
  ADMIN:      'ADMIN',
  DISPATCHER: 'DISPATCHER',
  HOSPITAL:   'HOSPITAL',
  DRIVER:     'DRIVER',
  CITIZEN:    'CITIZEN',
});
const ROLES_VALUES = Object.values(ROLES);

// ─── Emergency request lifecycle ─────────────────────────────────────────────
const REQUEST_STATUS = Object.freeze({
  PENDING:   'PENDING',
  ASSIGNED:  'ASSIGNED',
  EN_ROUTE:  'EN_ROUTE',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
});
const REQUEST_STATUS_VALUES = Object.values(REQUEST_STATUS);

// ─── Priority levels (ordered: index 0 = lowest) ─────────────────────────────
const REQUEST_PRIORITY = Object.freeze({
  LOW:      'LOW',
  MEDIUM:   'MEDIUM',
  HIGH:     'HIGH',
  CRITICAL: 'CRITICAL',
});
const REQUEST_PRIORITY_VALUES = Object.values(REQUEST_PRIORITY);

// ─── Request types ────────────────────────────────────────────────────────────
const REQUEST_TYPES = Object.freeze({
  MEDICAL:  'MEDICAL',
  ACCIDENT: 'ACCIDENT',
  FIRE:     'FIRE',
  OTHER:    'OTHER',
});
const REQUEST_TYPES_VALUES = Object.values(REQUEST_TYPES);

// ─── Service level targets for emergency requests ─────────────────────────────
const SLA_TARGET_SECONDS = Object.freeze({
  [REQUEST_PRIORITY.CRITICAL]: 300,
  [REQUEST_PRIORITY.HIGH]:     600,
  [REQUEST_PRIORITY.MEDIUM]:  1200,
  [REQUEST_PRIORITY.LOW]:     1800,
});

const SLA_STATUS = Object.freeze({
  ON_TRACK: 'ON_TRACK',
  AT_RISK:  'AT_RISK',
  BREACHED: 'BREACHED',
});

// ─── Ambulance status lifecycle ───────────────────────────────────────────────
const AMBULANCE_STATUS = Object.freeze({
  AVAILABLE:   'AVAILABLE',
  ASSIGNED:    'ASSIGNED',
  EN_ROUTE:    'EN_ROUTE', // ✅ Consistent with frontend expectations
  ENROUTE:     'EN_ROUTE', // Legacy compatibility alias
  BUSY:        'BUSY',
  MAINTENANCE: 'MAINTENANCE',
});
const AMBULANCE_STATUS_VALUES = Object.values(AMBULANCE_STATUS);

// ─── Dispatch log status ──────────────────────────────────────────────────────
const DISPATCH_STATUS = Object.freeze({
  PENDING:   'PENDING',
  QUEUED:    'QUEUED',
  ACTIVE:    'ACTIVE',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
});
const DISPATCH_STATUS_VALUES = Object.values(DISPATCH_STATUS);

// ─── Ambulance valid status transitions ───────────────────────────────────────
const AMBULANCE_TRANSITIONS = Object.freeze({
  [AMBULANCE_STATUS.AVAILABLE]:   [AMBULANCE_STATUS.ASSIGNED, AMBULANCE_STATUS.MAINTENANCE],
  [AMBULANCE_STATUS.ASSIGNED]:    [AMBULANCE_STATUS.EN_ROUTE,  AMBULANCE_STATUS.AVAILABLE],
  [AMBULANCE_STATUS.EN_ROUTE]:    [AMBULANCE_STATUS.BUSY,     AMBULANCE_STATUS.AVAILABLE],
  [AMBULANCE_STATUS.BUSY]:        [AMBULANCE_STATUS.AVAILABLE],
  [AMBULANCE_STATUS.MAINTENANCE]: [AMBULANCE_STATUS.AVAILABLE],
});

// ─── Request valid status transitions (driver-facing) ────────────────────────
const REQUEST_TRANSITIONS = Object.freeze({
  [REQUEST_STATUS.ASSIGNED]: [REQUEST_STATUS.EN_ROUTE,  REQUEST_STATUS.CANCELLED],
  [REQUEST_STATUS.EN_ROUTE]: [REQUEST_STATUS.COMPLETED, REQUEST_STATUS.CANCELLED],
});

module.exports = {
  ROLES,
  ROLES_VALUES,
  REQUEST_STATUS,
  REQUEST_STATUS_VALUES,
  REQUEST_PRIORITY,
  REQUEST_PRIORITY_VALUES,
  REQUEST_TYPES,
  REQUEST_TYPES_VALUES,
  AMBULANCE_STATUS,
  AMBULANCE_STATUS_VALUES,
  DISPATCH_STATUS,
  DISPATCH_STATUS_VALUES,
  AMBULANCE_TRANSITIONS,
  REQUEST_TRANSITIONS,
  SLA_TARGET_SECONDS,
  SLA_STATUS,
};
