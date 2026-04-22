'use strict';

/**
 * Dynamic Dispatch Scoring System
 * Adapts scoring factors based on real-time system state
 */

class DynamicDispatchScorer {
  constructor() {
    this.baseWeights = {
      distance: 0.30,
      eta: 0.30,
      priority: 0.20,
      hospital: 0.20,
    };

    this.systemState = {
      queueLength: 0,
      ambulanceUtilization: 0,
      errorRate: 0,
      avgResponseTime: 0,
    };
  }

  // Update system state for dynamic adjustments
  updateSystemState(stats) {
    this.systemState = {
      queueLength: stats.waiting || 0,
      ambulanceUtilization: stats.allocations > 0 ? (stats.allocations / (stats.allocations + stats.rejections)) : 0,
      errorRate: stats.requests > 0 ? (stats.errors / stats.requests) : 0,
      avgResponseTime: stats.avgResponseTime || 0,
    };
  }

  // Dynamic weight adjustment based on system load
  getAdaptiveWeights() {
    const weights = { ...this.baseWeights };
    const queueStress = Math.min(1, this.systemState.queueLength / 100); // Stress from 0 to 100 queue items

    if (queueStress > 0.7) {
      // Under high load: prioritize speed over distance
      weights.distance = 0.20;
      weights.eta = 0.40;
      weights.priority = 0.25;
      weights.hospital = 0.15;
    } else if (queueStress > 0.4) {
      // Moderate load: balance speed and accuracy
      weights.distance = 0.25;
      weights.eta = 0.35;
      weights.priority = 0.22;
      weights.hospital = 0.18;
    }

    // Boost priority weight if error rate high
    if (this.systemState.errorRate > 0.05) {
      weights.priority *= 1.2;
      weights.distance *= 0.8;
    }

    return weights;
  }

  // ML-based predictive scoring (rule-based approximation)
  score(ambulance, request, hospital, systemMetrics) {
    this.updateSystemState(systemMetrics);
    const weights = this.getAdaptiveWeights();

    let score = 0;

    // Distance score (normalized 0-1)
    const distance = Math.hypot(
      ambulance.currentLocation.coordinates[0] - request.location.coordinates[0],
      ambulance.currentLocation.coordinates[1] - request.location.coordinates[1]
    ) * 111; // Rough km conversion
    const distanceScore = Math.max(0, (50 - distance) / 50); // 50km = 0, 0km = 1
    score += distanceScore * weights.distance;

    // ETA score (rule-based prediction)
    const eta = request.estimatedEta || (distance / 40) * 60; // km / 40km/h avg speed
    const etaScore = Math.max(0, (600 - eta) / 600); // 600s = 0, 0s = 1
    score += etaScore * weights.eta;

    // Priority score
    const priorityMap = { CRITICAL: 1.0, HIGH: 0.7, MEDIUM: 0.4, LOW: 0.1 };
    const priorityScore = priorityMap[request.priority] || 0.5;
    score += priorityScore * weights.priority;

    // Hospital compatibility score
    let hospitalScore = 0;
    if (hospital) {
      const hospitalDistance = Math.hypot(
        ambulance.currentLocation.coordinates[0] - hospital.location.coordinates[0],
        ambulance.currentLocation.coordinates[1] - hospital.location.coordinates[1]
      ) * 111;
      hospitalScore = hospitalDistance < 30 ? 1.0 : Math.max(0, (50 - hospitalDistance) / 50);
    } else {
      hospitalScore = 0.7; // Neutral if no hospital
    }
    score += hospitalScore * weights.hospital;

    // Apply recency bonus (prefer ambulances recently successful in similar priority)
    const recentSuccessBonus = (ambulance.recentSuccessCount || 0) * 0.02;
    score = Math.min(1.0, score + recentSuccessBonus);

    return score;
  }
}

module.exports = DynamicDispatchScorer;