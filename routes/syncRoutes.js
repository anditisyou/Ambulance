'use strict';

/**
 * Frontend State Sync & Recovery Endpoint
 * 
 * Endpoints to:
 * - Perform full state sync for UI recovery
 * - Replay missed events
 * - Verify UI consistency
 * - Rebuild state after disconnection
 */

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const role = require('../middleware/role');
const { validate } = require('../middleware/validate');
const { ROLES } = require('../utils/constants');
const EmergencyRequest = require('../models/EmergencyRequest');
const Ambulance = require('../models/Ambulance');
const Hospital = require('../models/Hospital');
const eventConsistency = require('../utils/eventConsistency');
const redisClient = require('../utils/redisClient');
const logger = require('../utils/logger');
const haversine = require('../utils/haversine');

/**
 * POST /api/sync/full-state
 * 
 * Complete state sync for UI recovery after disconnection
 * Returns:
 * - Current user/ambulance state
 * - Active requests
 * - Missed events since last sync
 * - Location data
 * - Metrics snapshot
 * 
 * Used on:
 * - App startup (restore from cache)
 * - Reconnection after network loss
 * - Tab focus regain
 */
router.post(
  '/full-state',
  auth.authJwt,
  validate({
    body: {
      required: ['clientVersion', 'lastSyncTimestamp', 'lastKnownState']
    }
  }),
  async (req, res) => {
    try {
      const userId = req.userId;
      const userRole = req.userRole;
      const { lastSyncTimestamp, lastKnownState } = req.body;
      const now = Date.now();

      // Determine user type and fetch relevant data
      let state = {
        user: { id: userId.toString(), email: req.user.email },
        syncedAt: now,
        serverVersion: process.env.API_VERSION || '1.0.0',
        clientVersion: req.body.clientVersion,
        timeDriftMs: now - lastSyncTimestamp, // How much time passed on client
      };

      // ─────────────────────────────────────────────────────────────
      // User (Citizen) State
      // ─────────────────────────────────────────────────────────────
      if (userRole === ROLES.CITIZEN) {
        // Get active request
        const activeRequest = await EmergencyRequest.findOne({
          userId,
          status: { $in: ['PENDING', 'ASSIGNED', 'EN_ROUTE'] },
        })
          .select(
            '_id status assignmentState priority type requestTime assignedAmbulanceId assignedHospital ' +
            'acceptedTime enRouteTime location description vitals'
          )
          .lean();

        if (activeRequest) {
          // Get ambulance details
          const ambulance = await Ambulance.findById(activeRequest.assignedAmbulanceId)
            .select('callSign plateNumber driverId')
            .lean();

          // Get driver location
          const locationKey = `driver:location:${activeRequest.assignedAmbulanceId}`;
          const locationData = await redisClient.get(locationKey);
          const driverLocation = locationData ? JSON.parse(locationData) : null;

          // Calculate distances
          let distances = {};
          if (driverLocation && activeRequest.assignedHospital) {
              const hospital = await Hospital.findById(activeRequest.assignedHospital)
              .lean();

            if (hospital?.location?.coordinates) {
              distances.toHospital = haversine(
                driverLocation.location.coordinates[1],
                driverLocation.location.coordinates[0],
                hospital.location.coordinates[1],
                hospital.location.coordinates[0]
              ).toFixed(2);
            }
          }

          state.activeRequest = {
            id: activeRequest._id.toString(),
            status: activeRequest.status,
            assignmentState: activeRequest.assignmentState,
            priority: activeRequest.priority,
            type: activeRequest.type,
            requestTime: activeRequest.requestTime,
            acceptedTime: activeRequest.acceptedTime,
            enRouteTime: activeRequest.enRouteTime,
            ambulance: ambulance ? {
              id: ambulance._id.toString(),
              callSign: ambulance.callSign,
              plateNumber: ambulance.plateNumber,
            } : null,
            driverLocation,
            distances,
          };
        }

        // Get recent requests (for history)
        const recentRequests = await EmergencyRequest.find({
          userId,
          status: 'COMPLETED',
        })
          .select('_id requestTime completionTime priority type assignmentState')
          .sort({ completionTime: -1 })
          .limit(5)
          .lean();

        state.recentRequests = recentRequests.map(r => ({
          id: r._id.toString(),
          requestTime: r.requestTime,
          completionTime: r.completionTime,
          priority: r.priority,
          type: r.type,
          duration: Math.round((r.completionTime - r.requestTime) / 1000),
        }));
      }

      // ─────────────────────────────────────────────────────────────
      // Ambulance/Driver State
      // ─────────────────────────────────────────────────────────────
      if (userRole === ROLES.DRIVER) {
        const ambulance = await Ambulance.findOne({ driverId: userId })
          .select('_id callSign plateNumber status isActive currentLocation')
          .lean();

        if (ambulance) {
          state.ambulance = {
            id: ambulance._id.toString(),
            callSign: ambulance.callSign,
            plateNumber: ambulance.plateNumber,
            status: ambulance.status,
            isActive: ambulance.isActive,
            location: ambulance.currentLocation,
          };

          // Get current assignment
          const assignment = await EmergencyRequest.findOne({
            assignedAmbulanceId: ambulance._id,
            assignmentState: { $in: ['ASSIGNED', 'ACCEPTED', 'EN_ROUTE'] },
          })
            .select(
              '_id status assignmentState priority type userName userPhone location ' +
              'assignedHospital vitals acceptedTime enRouteTime assignmentAcceptanceDeadline'
            )
            .lean();

          if (assignment) {
            state.currentAssignment = {
              id: assignment._id.toString(),
              status: assignment.status,
              assignmentState: assignment.assignmentState,
              priority: assignment.priority,
              type: assignment.type,
              patient: {
                name: assignment.userName,
                phone: assignment.userPhone,
                vitals: assignment.vitals,
              },
              location: assignment.location,
              hospital: assignment.assignedHospital?.toString(),
              acceptedTime: assignment.acceptedTime,
              enRouteTime: assignment.enRouteTime,
              slaDeadline: assignment.assignmentAcceptanceDeadline,
              slaExpiredMs: assignment.assignmentAcceptanceDeadline
                ? Math.max(0, assignment.assignmentAcceptanceDeadline - now)
                : null,
            };
          }
        }
      }

      // ─────────────────────────────────────────────────────────────
      // Hospital State
      // ─────────────────────────────────────────────────────────────
      if (userRole === ROLES.HOSPITAL) {
        // Get incoming ambulances
        const incomingRequests = await EmergencyRequest.find({
          assignedHospital: userId,
          assignmentState: { $in: ['ACCEPTED', 'EN_ROUTE'] },
        })
          .select(
            '_id priority userName userPhone vitals enRouteTime ' +
            'assignedAmbulanceId location'
          )
          .lean();

        state.incomingAmbulances = await Promise.all(
          incomingRequests.map(async (req) => {
            const locationKey = `driver:location:${req.assignedAmbulanceId}`;
            const locationData = await redisClient.get(locationKey);
            const driverLocation = locationData ? JSON.parse(locationData) : null;

            return {
              requestId: req._id.toString(),
              priority: req.priority,
              patient: {
                name: req.userName,
                phone: req.userPhone,
                vitals: req.vitals,
              },
              driverLocation,
              eta: driverLocation?.eta,
              distance: driverLocation?.distanceToHospital,
            };
          })
        );
      }

      // ─────────────────────────────────────────────────────────────
      // Missed Events (Events since last sync)
      // ─────────────────────────────────────────────────────────────
      if (lastSyncTimestamp && state.activeRequest?.id) {
        const missedEvents = await eventConsistency.getEventSequence(
          state.activeRequest.id,
          lastSyncTimestamp
        );

        state.missedEvents = missedEvents || [];
      }

      // ─────────────────────────────────────────────────────────────
      // UI Version
      // ─────────────────────────────────────────────────────────────
      state.uiState = {
        staleDataWarningMs: 300000, // Warn if data > 5 minutes old
        requiresRefresh: state.timeDriftMs > 600000, // Force refresh after 10 min
        completenessScore: this._calculateCompletenessScore(state), // 0-100
      };

      res.json({
        success: true,
        state,
        timestamp: now,
      });
    } catch (err) {
      logger.error(`Full state sync failed: ${err.message}`);
      res.status(500).json({ error: 'State sync failed' });
    }
  }
);

/**
 * GET /api/sync/verify-consistency
 * 
 * Verify UI state consistency with server
 * Returns:
 * - Consistency issues detected
 * - Fields that diverged from server
 * - Recommended fix actions
 */
router.get(
  '/verify-consistency',
  auth.authJwt,
  validate({
    query: {
      required: ['requestId', 'state']
    }
  }),
  async (req, res) => {
    try {
      const { requestId, state: uiStateStr } = req.query;
      const uiState = uiStateStr ? JSON.parse(uiStateStr) : {};

      const dbState = await EmergencyRequest.findById(requestId)
        .select('status assignmentState assignedAmbulanceId acceptedTime enRouteTime')
        .lean();

      if (!dbState) {
        return res.status(404).json({ error: 'Request not found' });
      }

      // Compare states
      const issues = [];

      if (uiState.status !== dbState.status) {
        issues.push({
          field: 'status',
          uiValue: uiState.status,
          dbValue: dbState.status,
          severity: 'HIGH',
          action: 'REFRESH',
        });
      }

      if (uiState.assignmentState !== dbState.assignmentState) {
        issues.push({
          field: 'assignmentState',
          uiValue: uiState.assignmentState,
          dbValue: dbState.assignmentState,
          severity: 'CRITICAL',
          action: 'FULL_RESYNC',
        });
      }

      // Check version consistency
      const stream = await eventConsistency.getEventSequence(requestId);
      const serverVersion = stream?.length || 0;
      const uiVersion = uiState.version || 0;

      if (uiVersion !== serverVersion) {
        issues.push({
          field: 'eventVersion',
          uiValue: uiVersion,
          serverValue: serverVersion,
          severity: 'MEDIUM',
          action: 'REPLAY_EVENTS',
          missedEvents: serverVersion - uiVersion,
        });
      }

      const consistent = issues.length === 0;

      res.json({
        success: true,
        consistent,
        issues,
        recommendations: this._getRecoveryRecommendations(issues),
      });
    } catch (err) {
      logger.error(`Consistency check failed: ${err.message}`);
      res.status(500).json({ error: 'Consistency check failed' });
    }
  }
);

/**
 * GET /api/sync/event-replay
 * 
 * Replay events since a given timestamp for UI recovery
 */
router.get(
  '/event-replay',
  auth.authJwt,
  validate({
    query: {
      required: ['requestId', 'fromTimestamp'],
      optional: ['maxEvents'],
      isNumeric: ['fromTimestamp', 'maxEvents']
    }
  }),
  async (req, res) => {
    try {
      const { requestId, fromTimestamp, maxEvents = 100 } = req.query;

      // Get events from stream
      const events = await eventConsistency.getEventSequence(requestId);

      if (!events) {
        return res.json({ events: [] });
      }

      // Filter and limit
      const filtered = events
        .filter(e => e.timestamp > (fromTimestamp || 0))
        .slice(0, maxEvents);

      res.json({
        success: true,
        events: filtered,
        count: filtered.length,
        totalAvailable: events.length,
      });
    } catch (err) {
      logger.error(`Event replay failed: ${err.message}`);
      res.status(500).json({ error: 'Event replay failed' });
    }
  }
);

/**
 * Calculate state completeness score
 */
function _calculateCompletenessScore(state) {
  let score = 50; // Base score

  if (state.activeRequest) score += 20;
  if (state.ambulance) score += 15;
  if (state.incomingAmbulances?.length > 0) score += 15;

  return Math.min(100, score);
}

/**
 * Get recovery recommendations
 */
function _getRecoveryRecommendations(issues) {
  const recommendations = [];

  const criticalIssues = issues.filter(i => i.severity === 'CRITICAL');
  if (criticalIssues.length > 0) {
    recommendations.push({
      priority: 'CRITICAL',
      action: 'FULL_RESYNC',
      message: 'Critical state divergence detected. Perform full state sync.',
    });
  }

  const versionIssues = issues.filter(i => i.field === 'eventVersion');
  if (versionIssues.length > 0) {
    recommendations.push({
      priority: 'HIGH',
      action: 'REPLAY_EVENTS',
      message: `Replay ${versionIssues[0].missedEvents} missed events.`,
    });
  }

  if (recommendations.length === 0) {
    recommendations.push({
      priority: 'LOW',
      action: 'CONTINUE',
      message: 'UI state is consistent with server.',
    });
  }

  return recommendations;
}

module.exports = router;
