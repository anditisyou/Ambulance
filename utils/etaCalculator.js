'use strict';

/**
 * ETA Calculator
 * ───────────────
 * Estimates the travel time between two coordinates.
 *
 * Strategy (with graceful fallback):
 *  1. If OSRM_ROUTING_URL is set, call the public OSRM HTTP API for a real road-network
 *     duration.  OSRM returns durations in seconds.
 *  2. If OSRM is unavailable or times out, fall back to a straight-line Haversine
 *     estimate at an assumed average urban speed of 40 km/h.
 *
 * The OSRM endpoint used:
 *   GET {OSRM_ROUTING_URL}/route/v1/driving/{lng1},{lat1};{lng2},{lat2}
 *       ?overview=false&annotations=false
 *
 * Production alternatives: Google Maps Distance Matrix API, Mapbox Directions API,
 *   HERE Routing API — swap out the _fetchOsrmEta function below.
 */

const https  = require('https');
const http   = require('http');
const { haversineDistance } = require('./haversine');

// ─── Constants ────────────────────────────────────────────────────────────────

const ASSUMED_SPEED_KMH   = 40;           // conservative urban ambulance speed
const OSRM_TIMEOUT_MS     = 3_000;        // 3 s — fall back to Haversine if OSRM takes longer
const MAX_RETRIES         = 1;            // one retry on transient OSRM errors

// ─── OSRM integration ─────────────────────────────────────────────────────────

/**
 * Fetch ETA from OSRM routing server.
 *
 * @param {[number,number]} from - [lng, lat]
 * @param {[number,number]} to   - [lng, lat]
 * @returns {Promise<number>} ETA in seconds
 * @throws {Error} if OSRM request fails or times out
 */
const _fetchOsrmEta = (from, to) =>
  new Promise((resolve, reject) => {
    const baseUrl  = process.env.OSRM_ROUTING_URL || 'http://router.project-osrm.org';
    const coords   = `${from[0]},${from[1]};${to[0]},${to[1]}`;
    const path     = `/route/v1/driving/${coords}?overview=false&annotations=false`;
    const fullUrl  = `${baseUrl}${path}`;

    const lib     = fullUrl.startsWith('https') ? https : http;
    const timeout = setTimeout(() => reject(new Error('OSRM timeout')), OSRM_TIMEOUT_MS);

    const req = lib.get(fullUrl, (res) => {
      clearTimeout(timeout);
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try {
          const body = JSON.parse(raw);
          if (body.code !== 'Ok' || !body.routes?.[0]) {
            return reject(new Error(`OSRM error: ${body.code}`));
          }
          resolve(Math.round(body.routes[0].duration));
        } catch (parseErr) {
          reject(new Error('OSRM response parse error'));
        }
      });
    });

    req.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    req.setTimeout(OSRM_TIMEOUT_MS, () => {
      req.destroy();
      reject(new Error('OSRM socket timeout'));
    });
  });

// ─── Haversine fallback ───────────────────────────────────────────────────────

/**
 * Straight-line ETA estimate (seconds).
 *
 * @param {[number,number]} from - [lng, lat]
 * @param {[number,number]} to   - [lng, lat]
 * @returns {number}
 */
const _haversineEta = (from, to) => {
  const distM    = haversineDistance(from[1], from[0], to[1], to[0]);
  const speedMs  = (ASSUMED_SPEED_KMH * 1000) / 3600;
  return Math.max(1, Math.round(distM / speedMs));
};

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Get estimated travel time in seconds between two [lng, lat] coordinate pairs.
 *
 * Tries OSRM first; falls back silently to Haversine estimate on any error.
 *
 * @param {[number,number]} from - [longitude, latitude] of origin
 * @param {[number,number]} to   - [longitude, latitude] of destination
 * @returns {Promise<number>} Travel time estimate in seconds (minimum 1)
 */
const getETA = async (from, to) => {
  // Guard: both coordinates must be valid arrays
  if (
    !Array.isArray(from) || from.length < 2 ||
    !Array.isArray(to)   || to.length   < 2
  ) {
    console.warn('[ETA] Invalid coordinates — returning 0');
    return 0;
  }

  // If OSRM is configured, attempt a real routing request
  if (process.env.OSRM_ROUTING_URL) {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await _fetchOsrmEta(from, to);
      } catch (err) {
        if (attempt < MAX_RETRIES) {
          // brief pause before retry
          await new Promise((r) => setTimeout(r, 200));
        } else {
          console.warn(`[ETA] OSRM unavailable (${err.message}) — using Haversine fallback`);
        }
      }
    }
  }

  // Haversine fallback
  return _haversineEta(from, to);
};

/**
 * Get ETA as a formatted string for display (e.g. "12 min").
 *
 * @param {[number,number]} from
 * @param {[number,number]} to
 * @returns {Promise<string>}
 */
const getETAFormatted = async (from, to) => {
  const secs = await getETA(from, to);
  const mins = Math.round(secs / 60);
  return mins < 1 ? 'Less than 1 min' : `${mins} min`;
};

module.exports = { getETA, getETAFormatted };
