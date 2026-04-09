# Real-Time Tracking & Monitoring System

## Overview

The ERS system now includes a comprehensive real-time tracking and monitoring system that provides:

1. **Driver Real-Time Location Tracking** - Live ambulance location updates during en-route
2. **Hospital Receiving Dashboard** - Real-time incoming ambulance tracking with ETA
3. **System-Wide Monitoring** - Admin dashboards showing system health, queue depth, ambulance utilization
4. **Performance Metrics** - Automatic calculation of response times, transport times, and system KPIs
5. **Event Consistency** - Strict ordering of events to prevent stale UI updates and race conditions

---

## Architecture

### Data Flow

```
Driver Updates Location
    ↓
PATCH /api/driver/location
    ↓
Redis stores location (TTL: 1 hour)
    ↓
Publishes to Redis channel `request:tracking:{requestId}`
    ↓
Hospital receives update via Socket.IO or SSE
    ↓
Real-time dashboard updates ambulance position
```

### Storage Strategy

- **MongoDB**: Persistent storage of requests, locations (periodic sync), audit trails
- **Redis**: Real-time location data (KV with TTL), event streams, metrics snapshots
- **Socket.IO**: Real-time push to clients via Redis pub/sub adapter
- **Server-Sent Events (SSE)**: Alternative to WebSocket for tracking streams

---

## New Database Fields (EmergencyRequest Model)

```javascript
{
  // State machine tracking
  assignmentState: 'PENDING' | 'ASSIGNED' | 'ACCEPTED' | 'EN_ROUTE' | 'REJECTED',
  assignmentAcceptanceDeadline: Date, // SLA timeout for driver acceptance
  
  // Driver lifecycle timestamps
  acceptedTime: Date,      // When driver accepted assignment
  enRouteTime: Date,       // When driver marked en-route
  rejectionReason: String, // Why driver rejected (if applicable)
  rejectionTime: Date,     // When driver rejected
  
  // Real-time driver location tracking
  driverLocation: {        // GeoJSON Point for mapping
    type: 'Point',
    coordinates: [longitude, latitude]
  }
}
```

---

## API Endpoints

### Driver Real-Time Location Updates

#### PATCH `/api/driver/location`
Updates driver's current location during en-route.

**Headers:**
- `Authorization: Bearer {jwt_token}` (required)

**Body:**
```json
{
  "ambulanceId": "ObjectId",
  "requestId": "ObjectId",
  "location": {
    "longitude": -73.935242,
    "latitude": 40.730610
  },
  "speed": 60,         // km/h (optional)
  "heading": 180,      // degrees (optional)
  "accuracy": 5        // meters (optional)
}
```

**Response:**
```json
{
  "success": true,
  "distanceToHospital": "2.34",      // km
  "eta": 3,                           // minutes
  "message": "Location updated"
}
```

**Real-Time Flow:**
1. Driver's location stored in Redis: `driver:location:{ambulanceId}`
2. Event published to `request:tracking:{requestId}` channel
3. All hospital clients receive Socket.IO event: `driver-location`
4. Distance to hospital calculated using Haversine formula
5. ETA computed based on current speed

---

#### GET `/api/driver/current-assignment`
Get current active assignment for driver with distances and ETAs.

**Response:**
```json
{
  "assignment": {
    "requestId": "ObjectId",
    "patientName": "John Doe",
    "patientPhone": "+1234567890",
    "status": "EN_ROUTE",
    "assignmentState": "EN_ROUTE",
    "priority": "CRITICAL",
    "type": "TRAUMA",
    "patientLocation": {
      "lat": 40.730610,
      "lon": -73.935242
    },
    "distanceToPatient": "2.34",    // km
    "hospital": {
      "id": "ObjectId",
      "name": "St. Mary's Hospital",
      "address": "123 Main St",
      "phone": "+1-555-0100"
    },
    "distanceToHospital": "3.45",   // km
    "acceptedTime": "2024-01-15T10:30:00Z",
    "enRouteTime": "2024-01-15T10:35:00Z"
  }
}
```

---

#### GET `/api/driver/assignment-history`
Get driver's recent completed assignments for performance tracking.

**Query Parameters:**
- `limit` - Number of recent assignments (max 50, default 10)

**Response:**
```json
{
  "history": [
    {
      "requestId": "ObjectId",
      "patientName": "Jane Smith",
      "priority": "HIGH",
      "type": "MEDICAL",
      "requestTime": "2024-01-15T09:00:00Z",
      "acceptedTime": "2024-01-15T09:05:00Z",
      "enRouteTime": "2024-01-15T09:10:00Z",
      "completedTime": "2024-01-15T09:45:00Z",
      "responseTime": 5,              // minutes (request to acceptance)
      "transportTime": 35             // minutes (en-route to completion)
    }
  ],
  "count": 10
}
```

---

### Hospital Receiving & Tracking

#### GET `/api/hospital-tracking/incoming-ambulances`
Get all incoming ambulances headed to hospital with real-time location and ETA.

**Headers:**
- `Authorization: Bearer {jwt_token}` (hospital user)

**Response:**
```json
{
  "ambulances": [
    {
      "requestId": "ObjectId",
      "ambulance": {
        "id": "ObjectId",
        "callSign": "AMB-001"
      },
      "patient": {
        "name": "John Doe",
        "phone": "+1234567890",
        "vitals": {
          "heartRate": 92,
          "bloodPressure": "140/90"
        },
        "priority": "CRITICAL"
      },
      "status": "EN_ROUTE",
      "assignmentState": "EN_ROUTE",
      "type": "TRAUMA",
      "requestTime": "2024-01-15T10:00:00Z",
      "enRouteTime": "2024-01-15T10:05:00Z",
      "location": {
        "type": "Point",
        "coordinates": [-73.935242, 40.730610]
      },
      "distanceKm": "2.34",
      "etaMinutes": 3,
      "lastLocationUpdate": 1705316400000
    }
  ],
  "count": 1
}
```

---

#### GET `/api/hospital-tracking/ambulance/{ambulanceId}/tracking`
Server-Sent Events (SSE) stream for real-time ambulance location tracking.

**Usage:**
```javascript
// Client-side
const eventSource = new EventSource(
  '/api/hospital-tracking/ambulance/{ambulanceId}/tracking',
  { headers: { Authorization: `Bearer ${token}` } }
);

eventSource.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log('Location update:', data);
};

eventSource.onerror = (error) => {
  console.error('Connection lost:', error);
  eventSource.close();
};
```

**Message Format:**
```json
{
  "type": "driver-location-update",
  "ambulanceId": "ObjectId",
  "location": {
    "type": "Point",
    "coordinates": [-73.935242, 40.730610]
  },
  "distanceToHospital": "2.34",
  "eta": 3,
  "speed": 60,
  "heading": 180,
  "accuracy": 5,
  "timestamp": 1705316400000
}
```

---

#### GET `/api/hospital-tracking/tracking-dashboard`
Comprehensive dashboard data for hospital receiving team.

**Response:**
```json
{
  "dashboard": {
    "totalIncoming": 3,
    "readyBeds": 8,
    "ambulancesByPriority": {
      "CRITICAL": [
        { /* ambulance data */ }
      ],
      "HIGH": [
        { /* ambulance data */ }
      ],
      "MEDIUM": [],
      "LOW": []
    },
    "statistics": {
      "totalAmbulances": 3,
      "withActiveLocation": 3,
      "averageETA": 8,
      "criticalCount": 1,
      "highCount": 2
    }
  }
}
```

---

#### POST `/api/hospital-tracking/prepare-bed`
Update bed preparation status when ambulance is nearby.

**Body:**
```json
{
  "requestId": "ObjectId",
  "bedType": "ICU",           // ICU | Emergency | General | Isolation
  "status": "ready"           // preparing | ready | occupied | discharge
}
```

**Response:**
```json
{
  "success": true,
  "message": "Bed status updated to ready"
}
```

**Real-Time Flow:**
1. Bed status stored in Redis: `hospital:bed:{requestId}` (TTL: 24 hours)
2. Socket.IO event emitted to ambulance: `bed-prepared`
3. Driver receives notification of bed readiness

---

### System Monitoring & Metrics

#### GET `/api/monitoring/system-metrics`
Get current system-wide metrics for admin/dispatcher dashboards.

**Headers:**
- `Authorization: Bearer {admin_jwt}`

**Response:**
```json
{
  "success": true,
  "metrics": {
    "timestamp": 1705316400000,
    "ambulances": {
      "total": 25,
      "active": 18,
      "utilization": "72.0"  // percentage
    },
    "requests": {
      "total": 156,
      "pending": 12,
      "assigned": 8,
      "enRoute": 18,
      "completed": 118,
      "pendingPercentage": "7.7"
    },
    "hospitals": 5,
    "performance": {
      "avgResponseTimeMinutes": 8,
      "avgTransportTimeMinutes": 22,
      "completedThisHour": 15
    },
    "healthStatus": {
      "status": "HEALTHY",      // HEALTHY | WARNING | CRITICAL
      "issues": [],
      "utilizationPercentage": "72.0"
    }
  },
  "timestamp": 1705316400000
}
```

---

#### GET `/api/monitoring/ambulance/{ambulanceId}/metrics`
Get specific ambulance performance metrics.

**Response:**
```json
{
  "success": true,
  "metrics": {
    "ambulanceId": "ObjectId",
    "status": "AVAILABLE",      // AVAILABLE | ASSIGNED | EN_ROUTE | MAINTENANCE
    "lastUpdate": 1705316400000,
    "currentRequestId": null,
    "location": { /* coordinates */ }
  },
  "timestamp": 1705316400000
}
```

---

#### GET `/api/monitoring/request/{requestId}/metrics`
Get request lifecycle metrics and timing information.

**Response:**
```json
{
  "success": true,
  "metrics": {
    "requestId": "ObjectId",
    "status": "EN_ROUTE",
    "assignmentState": "EN_ROUTE",
    "lastUpdate": 1705316400000,
    "lifecycle": {
      "PENDING": 1705316140000,
      "ASSIGNED": 1705316200000,
      "ACCEPTED": 1705316220000,
      "EN_ROUTE": 1705316280000
    },
    "timings": {
      "PENDING_to_ASSIGNED": { "seconds": 60, "minutes": "1.0" },
      "ASSIGNED_to_ACCEPTED": { "seconds": 20, "minutes": "0.3" },
      "ACCEPTED_to_EN_ROUTE": { "seconds": 60, "minutes": "1.0" }
    }
  },
  "timestamp": 1705316400000
}
```

---

#### GET `/api/monitoring/hospital/{hospitalId}/capacity`
Get hospital capacity and incoming ambulance load.

**Headers:**
- `Authorization: Bearer {hospital_jwt}`

**Response:**
```json
{
  "success": true,
  "metrics": {
    "hospitalId": "ObjectId",
    "hospitalName": "St. Mary's Hospital",
    "totalBeds": 50,
    "availableBeds": 35,
    "incomingAmbulances": 3,
    "capacity": "10.0",        // percentage of beds will be occupied
    "lastUpdate": 1705316400000
  },
  "timestamp": 1705316400000
}
```

---

#### GET `/api/monitoring/health-status`
System health status with appropriate HTTP status codes for alerting.

**Response Codes:**
- `200` - HEALTHY
- `202` - WARNING
- `503` - CRITICAL

**Response:**
```json
{
  "success": true,
  "health": {
    "status": "HEALTHY",
    "issues": [],
    "utilizationPercentage": "72.0"
  },
  "metrics": {
    "ambulances": { /* ... */ },
    "requests": { /* ... */ },
    "performance": { /* ... */ }
  },
  "timestamp": 1705316400000
}
```

---

## Real-Time Updates via Socket.IO

### Joining Monitoring Rooms

```javascript
// Admin monitoring all system metrics
socket.emit('join', 'monitoring:metrics');

// Director tracking specific ambulance
socket.emit('join', `ambulance:tracking:${ambulanceId}`);

// Hospital tracking incoming ambulances
socket.emit('join', `hospital:tracking:${hospitalId}`);

// Dispatcher tracking request status
socket.emit('join', `request:tracking:${requestId}`);
```

### Socket Events

#### `metrics-update`
published to `monitoring:metrics` room when system metrics change.

```javascript
socket.on('metrics-update', (data) => {
  console.log('System health:', data.metrics.healthStatus);
  console.log('Queue depth:', data.metrics.requests.pending);
});
```

#### `driver-location`
Published to `hospital:tracking:{hospitalId}` room when ambulance location updates.

```javascript
socket.on('driver-location', (data) => {
  console.log('Ambulance position:', data.location);
  console.log('ETA:', data.eta, 'minutes');
});
```

#### `bed-prepared`
Published to `ambulance:{ambulanceId}` room when hospital prepares bed.

```javascript
socket.on('bed-prepared', (data) => {
  console.log('Bed ready:', data.bedType, data.status);
});
```

---

## Integration Points

### State Machine Integration

The monitoring system is integrated with the RequestStateMachine to track state transitions:

```
PENDING (request created)
  ↓ [updateRequestStatus called]
  
ASSIGNED (ambulance allocated)
  ↓ [updateRequestStatus + updateAmbulanceStatus called]
  
ACCEPTED (driver accepts)
  ↓ [updateRequestStatus called]
  
EN_ROUTE (driver marks en-route)
  ↓ [updateRequestStatus + updateAmbulanceStatus called]
  
COMPLETED (request finished)
  ↓ [updateSystemMetrics called to recalculate KPIs]
```

### Automatic Metrics Updates

Metrics are automatically updated when:

1. **Request Created** → `PENDING` state recorded
2. **Ambulance Assigned** → Ambulance status → timing metrics calculated
3. **Driver Accepts** → Response time calculated
4. **Driver En-Route** → Transport time begins tracking
5. **Request Completed** → All timelines stored for analytics

---

## Performance Considerations

### Redis TTLs

- **Location data** (1 hour): Active during transport, expires post-delivery
- **Bed status** (24 hours): Persists for shift duration
- **Metrics snapshots** (30 seconds): Frequently recalculated, short cache
- **Request lifecycle** (24 hours): Full audit trail retention

### Scalability

- **Redis Streams** ensure strict event ordering (no race conditions)
- **Geospatial indexes** on MongoDB support location queries at scale
- **Socket.IO Redis adapter** distributes pub/sub across multiple servers
- **SSE fallback** for clients with WebSocket restrictions

### Database Queries Optimized

```javascript
// Efficiently query incoming ambulances
db.emergency_requests.find({
  assignedHospital: hospitalId,
  assignmentState: { $in: ['ACCEPTED', 'EN_ROUTE'] }
})
.index({ assignmentState: 1, assignedAmbulanceId: 1 })

// Track request lifecycle
db.emergency_requests.find({ _id: requestId })
.select('requestTime acceptedTime enRouteTime completionTime')
```

---

## Error Handling

### 503 Service Unavailable Responses

When system is overloaded and requests are being shed:

```json
{
  "success": false,
  "message": "System overload: please retry in 15 seconds",
  "backoffMs": 15000,
  "shedStatus": {
    "overloadLevel": "critical",
    "shedThreshold": "200 pending requests",
    "currentQueueDepth": 245
  }
}
```

### 409 Conflict Responses

When stale updates detected (event consistency):

```json
{
  "error": "This request has been updated by another user",
  "currentVersion": 2,
  "yourVersion": 1
}
```

---

## Deployment Checklist

- ✅ Redis cluster running with streams support
- ✅ MongoDB with geospatial indexes created
- ✅ Socket.IO Redis adapter configured
- ✅ SSL certificates for HTTPS (required for SSE)
- ✅ CORS configured for tracking dashboard
- ✅ Rate limiting applied to location update endpoints
- ✅ Monitoring alerts configured in observability platform

---

## Troubleshooting

### Location updates not appearing

1. Check ambulance is in `EN_ROUTE` state
2. Verify ambulanceId matches assigned ambulance
3. Confirm Redis connection and `driver:location:{}` key exists
4. Check Socket.IO room subscriptions

### Hospital dashboard showing stale locations

1. Verify location update TTL (should be 3600 seconds)
2. Check Redis expiration policies
3. Confirm driver is actively sending location updates (every 10-30 seconds) 
4. Verify client SSE or WebSocket connection is active

### Metrics showing incorrect queue depth

1. Run `/api/monitoring/health-status` to reload metrics
2. Check pending request count: `db.emergency_requests.countDocuments({ status: 'PENDING' })`
3. Verify load shedding isn't incorrectly filtering requests

---

## Future Enhancements

- **Predictive ETA** using machine learning on historical route data
- **Traffic-aware routing** integration with Google Maps or HERE APIs
- **Multi-hospital coordination** for load balancing
- **Autonomous alert routing** based on patient severity and hospital capability
- **Driver performance analytics** with individualized dashboards
