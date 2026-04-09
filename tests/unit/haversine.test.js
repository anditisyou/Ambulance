// tests/unit/haversine.test.js
const { haversineDistance } = require('../../utils/haversine');

describe('Haversine Distance Calculator', () => {
  test('calculates distance between two points correctly', () => {
    // New York to Los Angeles ~ 3935 km
    const nyLat = 40.7128, nyLng = -74.0060;
    const laLat = 34.0522, laLng = -118.2437;
    
    const distance = haversineDistance(nyLat, nyLng, laLat, laLng);
    
    expect(distance).toBeGreaterThan(3_900_000);
    expect(distance).toBeLessThan(4_000_000);
  });
  
  test('returns 0 for identical points', () => {
    const distance = haversineDistance(40.7128, -74.0060, 40.7128, -74.0060);
    expect(distance).toBe(0);
  });
  
  test('handles negative coordinates', () => {
    const distance = haversineDistance(-33.8688, 151.2093, -33.8688, 151.2093);
    expect(distance).toBe(0);
  });
});