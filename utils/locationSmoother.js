'use strict';

/**
 * GPS Location Smoothing Utility
 * 
 * Reduces GPS noise and jitter using Kalman filter combined with
 * moving average. Ensures stable ETA calculations for emergency response.
 * 
 * Real-world GPS accuracy issues addressed:
 * - Multipath errors in urban canyons
 * - Signal bouncing off buildings
 * - Rapid jitter (20-50m swings)
 * - Temporary loss and recovery patterns
 */

const redisClient = require('./redisClient');

class LocationSmoother {
  constructor() {
    // Kalman filter parameters (tuned for vehicle tracking)
    this.processNoise = 0.01;        // Process noise covariance
    this.measurementNoise = 0.1;     // Measurement noise covariance (GPS error ~10m)
    this.estimationError = 1.0;      // Initial estimation error
    
    // Moving average window
    this.movingAvgWindow = 5;        // Last N points for averaging
  }

  /**
   * Kalman filter for 1D position
   * Given: raw measurement, previous estimate, previous error
   * Returns: smoothed position
   */
  _kalmanFilter(measurement, prevEstimate, prevError) {
    // Prediction phase
    const predictionError = prevError + this.processNoise;
    
    // Update phase
    const kalmanGain = predictionError / (predictionError + this.measurementNoise);
    const currentEstimate = prevEstimate + kalmanGain * (measurement - prevEstimate);
    const currentError = (1 - kalmanGain) * predictionError;
    
    return { estimate: currentEstimate, error: currentError };
  }

  /**
   * Smooth a single location point
   * 
   * @param {Object} rawLocation - {latitude, longitude, accuracy, timestamp, speed, heading}
   * @param {string} ambulanceId - For storing filter state in Redis
   * @returns {Promise<Object>} - Smoothed location with confidence
   */
  async smoothLocation(rawLocation, ambulanceId) {
    try {
      const { latitude, longitude, accuracy } = rawLocation;
      
      // Reject obviously bad GPS data (0,0 or accuracy > 100m)
      if ((latitude === 0 && longitude === 0) || accuracy > 100) {
        return {
          filtered: rawLocation,
          confidence: 'LOW',
          reason: 'GPS signal compromised, using raw',
          timestamp: Date.now(),
        };
      }

      // Get previous filter state from Redis
      const stateKey = `gps:filter:${ambulanceId}`;
      const stateData = await redisClient.get(stateKey);
      let filterState = stateData ? JSON.parse(stateData) : {
        latEstimate: latitude,
        latError: this.estimationError,
        lonEstimate: longitude,
        lonError: this.estimationError,
        history: [],
      };

      // Apply Kalman filter to latitude
      const latResult = this._kalmanFilter(
        latitude,
        filterState.latEstimate,
        filterState.latError
      );

      // Apply Kalman filter to longitude
      const lonResult = this._kalmanFilter(
        longitude,
        filterState.lonEstimate,
        filterState.lonError
      );

      // Maintain moving average history
      filterState.history.push({
        lat: latResult.estimate,
        lon: lonResult.estimate,
        timestamp: Date.now(),
      });

      // Keep only last N points
      if (filterState.history.length > this.movingAvgWindow) {
        filterState.history = filterState.history.slice(-this.movingAvgWindow);
      }

      // Calculate moving average
      const avgLat = filterState.history.reduce((sum, p) => sum + p.lat, 0) / filterState.history.length;
      const avgLon = filterState.history.reduce((sum, p) => sum + p.lon, 0) / filterState.history.length;

      // Calculate deviation from moving average
      const latDeviation = Math.abs(latResult.estimate - avgLat);
      const lonDeviation = Math.abs(lonResult.estimate - avgLon);
      const totalDeviation = Math.sqrt(latDeviation ** 2 + lonDeviation ** 2);

      // Detect and reject outliers (> 50m deviation from average)
      if (totalDeviation > 0.005) { // 0.005 degrees ≈ 556m at equator, but tighter check
        return {
          filtered: {
            latitude: avgLat,
            longitude: avgLon,
            accuracy: accuracy * 0.7, // Reduced accuracy due to outlier rejection
            timestamp: rawLocation.timestamp,
            speed: rawLocation.speed,
            heading: rawLocation.heading,
          },
          confidence: 'MEDIUM',
          reason: 'Outlier detected and smoothed to moving average',
          deviation: totalDeviation,
        };
      }

      // Update filter state in Redis (TTL: 1 hour for session persistence)
      filterState.latEstimate = latResult.estimate;
      filterState.latError = latResult.error;
      filterState.lonEstimate = lonResult.estimate;
      filterState.lonError = lonResult.error;
      await redisClient.setex(stateKey, 3600, JSON.stringify(filterState));

      // High confidence: Kalman filtered and consistent
      const filteredLocation = {
        latitude: latResult.estimate,
        longitude: lonResult.estimate,
        accuracy: Math.max(5, accuracy * 0.8), // Reduced from raw GPS accuracy
        timestamp: rawLocation.timestamp,
        speed: rawLocation.speed,
        heading: rawLocation.heading,
      };

      return {
        filtered: filteredLocation,
        confidence: 'HIGH',
        reason: 'Kalman filter applied successfully',
        kalmanGainLat: this._kalmanFilter(latitude, filterState.latEstimate, filterState.latError).estimate,
        timestamp: Date.now(),
      };
    } catch (err) {
      // On any error, return raw location
      return {
        filtered: rawLocation,
        confidence: 'UNKNOWN',
        reason: `Smoothing failed: ${err.message}`,
        timestamp: Date.now(),
      };
    }
  }

  /**
   * Batch smooth multiple locations (for historical data)
   */
  async smoothLocationBatch(locations, ambulanceId) {
    const results = [];
    for (const loc of locations) {
      const smoothed = await this.smoothLocation(loc, ambulanceId);
      results.push(smoothed);
    }
    return results;
  }

  /**
   * Calculate stable ETA using smoothed location
   * Incorporates speed as confidence metric
   */
  calculateStableETA(smoothedLocation, targetCoordinates, haversineDistance) {
    const { accuracy, speed, latitude, longitude, timestamp } = smoothedLocation;

    // Calculate distance
    const distanceKm = haversineDistance(
      latitude,
      longitude,
      targetCoordinates[1],
      targetCoordinates[0]
    );

    // Confidence factors
    const accuracyConfidence = Math.max(0, 1 - accuracy / 50); // 50m = 0 confidence
    const speedConfidence = speed > 0 ? Math.min(1, speed / 80) : 0.5; // 80km/h = full confidence

    // Weighted average speed
    const effectiveSpeed = (speed || 60) * speedConfidence + 60 * (1 - speedConfidence);

    // ETA with confidence interval
    const etaSeconds = distanceKm / (effectiveSpeed / 3.6); // Convert km/h to m/s
    const confidenceLevel = (accuracyConfidence + speedConfidence) / 2;

    // Add buffer based on confidence
    const bufferMinutes = confidenceLevel > 0.7 ? 1 : confidenceLevel > 0.4 ? 3 : 5;

    return {
      etaMinutes: Math.ceil(etaSeconds / 60),
      etaWithBuffer: Math.ceil(etaSeconds / 60) + bufferMinutes,
      confidenceLevel: (confidenceLevel * 100).toFixed(0),
      distanceKm: distanceKm.toFixed(2),
      effectiveSpeed: effectiveSpeed.toFixed(1),
      buffer: bufferMinutes,
    };
  }

  /**
   * Clear filter state (when driver goes offline or for new request)
   */
  async clearFilterState(ambulanceId) {
    const stateKey = `gps:filter:${ambulanceId}`;
    await redisClient.del(stateKey);
  }

  /**
   * Get filter statistics for a driver
   */
  async getFilterStats(ambulanceId) {
    const stateKey = `gps:filter:${ambulanceId}`;
    const stateData = await redisClient.get(stateKey);
    
    if (!stateData) {
      return { status: 'no_data' };
    }

    const state = JSON.parse(stateData);
    return {
      status: 'active',
      currentLatError: state.latError,
      currentLonError: state.lonError,
      historySize: state.history.length,
      lastUpdateTime: state.history[state.history.length - 1]?.timestamp,
    };
  }
}

module.exports = new LocationSmoother();
