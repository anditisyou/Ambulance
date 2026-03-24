# Emergency Response System — API Documentation

**Version:** 2.0.0  
**Base URL:** `https://your-domain.com/api`  
**Auth:** Bearer JWT in `Authorization` header, or `token` httpOnly cookie

---

## Authentication

All protected endpoints require:
```
Authorization: Bearer <token>
```

Tokens expire after `JWT_EXPIRE` (default 7 days). Use `POST /auth/refresh` to extend.

---

## Roles

| Role | Description |
|------|-------------|
| `CITIZEN` | End user who can raise SOS requests |
| `DRIVER` | Ambulance driver; receives dispatch assignments |
| `HOSPITAL` | Hospital staff; can accept requests |
| `DISPATCHER` | Dispatch operator; sees all requests |
| `ADMIN` | Full system access |

---

## Error Response Format

```json
{
  "success": false,
  "status":  "fail",
  "message": "Human-readable description"
}
```

HTTP codes used: `200`, `201`, `400`, `401`, `403`, `404`, `503`.

---

## Endpoints

### Auth

#### `POST /auth/register`
Register a new user. Role is clamped to CITIZEN/DRIVER/HOSPITAL (cannot self-assign ADMIN).

**Body**
```json
{
  "name":     "Alice Smith",
  "email":    "alice@example.com",
  "phone":    "+12025550100",
  "password": "Secure@Pass1",
  "role":     "CITIZEN"
}
```

**Password rules:** ≥8 chars, 1 uppercase, 1 lowercase, 1 digit, 1 special char (`@$!%*?&`)

**Response `201`**
```json
{
  "success": true,
  "token":   "<jwt>",
  "user":    { "id": "...", "name": "Alice Smith", "email": "...", "role": "CITIZEN" }
}
```

---

#### `POST /auth/login`
Login with email or phone + password.

**Body** (email or phone, not both required)
```json
{ "email": "alice@example.com", "password": "Secure@Pass1" }
```

**Response `200`** — same shape as register.

---

#### `GET /auth/me` 🔒
Returns the currently authenticated user (no password field).

---

#### `POST /auth/logout` 🔒
Revokes the current token and clears the cookie.

---

#### `POST /auth/refresh` 🔒
Issues a new token and revokes the old one. Accepts a recently-expired token.

---

### Dispatch

#### `POST /dispatch/request` 🔒 `CITIZEN`
Create an SOS emergency request. Auto-dispatches nearest available ambulance.

**Body**
```json
{
  "latitude":    51.507351,
  "longitude":   -0.127758,
  "priority":    "HIGH",
  "type":        "MEDICAL",
  "description": "Chest pain, conscious"
}
```

| Field | Values | Default |
|-------|--------|---------|
| `priority` | `LOW`, `MEDIUM`, `HIGH`, `CRITICAL` | `MEDIUM` |
| `type` | `MEDICAL`, `ACCIDENT`, `FIRE`, `OTHER` | `MEDICAL` |
| `description` | max 500 chars | `""` |

**Response `201`**
```json
{
  "success":   true,
  "allocated": true,
  "data": {
    "_id":       "...",
    "status":    "ASSIGNED",
    "priority":  "HIGH",
    "location":  { "type": "Point", "coordinates": [-0.127758, 51.507351] },
    "requestTime": "2024-01-15T10:30:00.000Z"
  }
}
```

`allocated: false` means no ambulance was in range — request is queued.

---

#### `GET /dispatch/active` 🔒 `CITIZEN`
Returns the citizen's current active request (PENDING / ASSIGNED / EN_ROUTE), or `null`.

Includes `eta` (minutes) and `etaSeconds` when ambulance is assigned.

---

#### `PUT /dispatch/:id/response` 🔒 `DRIVER`
Driver accepts or rejects their assignment.

**Body**
```json
{ "accept": true }
```

On `accept: false`, the system immediately tries to assign the next nearest ambulance.

---

#### `PATCH /dispatch/:id/track` 🔒 `DRIVER`
Update location and/or status while en route. Only emits socket events if position moved >50 m.

**Body** (all fields optional)
```json
{
  "latitude":  51.51,
  "longitude": -0.12,
  "status":    "COMPLETED",
  "notes":     "Patient stable, en route to St Thomas'"
}
```

Valid status transitions for drivers:
- `ASSIGNED` → `EN_ROUTE` or `COMPLETED`
- `EN_ROUTE` → `COMPLETED`

---

#### `GET /dispatch/assignments` 🔒 `DRIVER`
Returns all active assignments for the driver's ambulance.

---

#### `DELETE /dispatch/:id` 🔒 `CITIZEN`
Cancel a PENDING or ASSIGNED request. Returns 400 if request is EN_ROUTE.

---

### Emergency

#### `GET /emergency` 🔒
List emergency requests. Role-filtered automatically:

| Role | Sees |
|------|------|
| `CITIZEN` | Own requests only |
| `DRIVER` | Requests assigned to their ambulance |
| `HOSPITAL` | PENDING requests + own accepted ones |
| `DISPATCHER` / `ADMIN` | All (with filters) |

**Query params** (ADMIN/DISPATCHER only)
- `status` — filter by status
- `priority` — filter by priority
- `startDate`, `endDate` — ISO date strings
- `page`, `limit` (max 100), `sortBy`

---

#### `POST /emergency` 🔒 `CITIZEN`
Alias for `POST /dispatch/request`.

---

#### `GET /emergency/:id` 🔒
Get single request. Access restricted to related parties (citizen, assigned hospital, assigned driver, admin).

---

#### `PUT /emergency/:id/accept` 🔒 `HOSPITAL`
Hospital accepts a PENDING request.

---

#### `PUT /emergency/:id/complete` 🔒 `DRIVER`
Driver marks an EN_ROUTE request as COMPLETED. Frees the ambulance automatically.

---

#### `GET /emergency/history` 🔒 `CITIZEN`
Paginated request history for the authenticated citizen. Includes `responseTimeMinutes`.

---

### Ambulances

#### `POST /ambulances` 🔒 `DRIVER`
Register a new ambulance or update the driver's existing one.

**Body**
```json
{
  "plateNumber": "AMB-001",
  "latitude":    51.5,
  "longitude":   -0.1,
  "status":      "AVAILABLE",
  "capacity":    2,
  "equipment":   ["defibrillator", "oxygen"]
}
```

`plateNumber` required only on first registration.

---

#### `GET /ambulances` 🔒 `ADMIN` `DISPATCHER` `DRIVER`
List ambulances. `DRIVER` only sees their own.

**Query params:** `status`, `available=true`, `nearby=true`, `maxDistance` (metres)

---

#### `PATCH /ambulances/:id/status` 🔒 `DRIVER` `ADMIN`
Update status with transition validation.

Valid transitions:

```
AVAILABLE   → ASSIGNED | MAINTENANCE
ASSIGNED    → ENROUTE  | AVAILABLE
ENROUTE     → BUSY     | AVAILABLE
BUSY        → AVAILABLE
MAINTENANCE → AVAILABLE
```

---

#### `PATCH /ambulances/:id/location` 🔒 `DRIVER`
Update GPS position. No-op if moved < 50 m (returns 200 with `message` field).

**Body:** `{ "longitude": -0.1, "latitude": 51.5 }`

---

### Admin

All admin endpoints require `ADMIN` role.

#### `GET /admin/users` — List users (`?page`, `?limit`, `?role`)
#### `GET /admin/users/:id` — Get user by ID
#### `PUT /admin/users/:id/role` — Update user role (`{ "role": "DISPATCHER" }`)
#### `DELETE /admin/users/:id` — Delete user + cascade (ambulances, requests)
#### `GET /admin/ambulances` — List all ambulances (`?status`, `?page`, `?limit`)
#### `GET /admin/stats` — System statistics

**Stats response**
```json
{
  "totalUsers":        142,
  "totalAmbulances":    18,
  "totalRequests":    3841,
  "pendingRequests":     2,
  "activeRequests":      5,
  "completedToday":     23,
  "roleDistribution": { "CITIZEN": 120, "DRIVER": 15, "HOSPITAL": 5, "ADMIN": 2 }
}
```

---

### Analytics

All analytics endpoints require `ADMIN` role.

#### `GET /analytics/latency`
Response-latency metrics.

**Query params:**
- `startDate`, `endDate` — ISO date strings
- `groupBy` — `hour` | `day` | `week` | `month`

**Response**
```json
{
  "metrics":    [{ "_id": { "year": 2024, "month": 1, "day": 15 }, "count": 12, "avgResponse": 45.3 }],
  "byPriority": [{ "_id": "CRITICAL", "count": 3, "avgResponse": 28.1 }],
  "dateRange":  { "start": "2024-01-01", "end": "2024-01-31" }
}
```

---

#### `GET /analytics/performance`
Daily metrics for the last N days.

**Query params:** `days` (1–365, default 30)

---

#### `GET /analytics/export`
Export data as JSON or CSV. Hard cap: 10,000 rows.

**Query params:** `format=json|csv`, `startDate`, `endDate`

For larger exports, use an async job queue.

---

### Medical Records

#### `POST /medical/upload` 🔒
Upload a medical document.

**Multipart form data:** `file` — JPEG, PNG, GIF, or PDF (max 10 MB)

---

#### `GET /medical/:userId` 🔒 `HOSPITAL` or owner
List records for a user. Hospital can view any patient's records.

**Query params:** `type=image|pdf|visit|prescription|note`, `page`, `limit`

---

#### `DELETE /medical/record/:id` 🔒 owner only
Delete record from DB and Cloudinary.

---

#### `POST /medical/share/:recordId` 🔒 owner only
Share a record with a hospital for a limited time.

**Body**
```json
{ "hospitalId": "...", "expiryHours": 24 }
```

`expiryHours` clamped to 1–168 (1 hour – 7 days).

---

## WebSocket Events (Socket.IO)

Connect to `ws://your-domain.com` with Socket.IO client.

### Client → Server

| Event | Payload | Purpose |
|-------|---------|---------|
| `join` | `{ userId, role }` | Join personal + role rooms |
| `joinRequest` | `{ requestId }` | Subscribe to request updates |
| `joinAmbulance` | `{ ambulanceId }` | Subscribe to ambulance updates |

### Server → Client

| Event | Payload | Sent to |
|-------|---------|---------|
| `ambulanceAssigned` | `{ ambulanceId, eta, estimatedArrival }` | Citizen |
| `ambulanceEnRoute` | `{ eta, etaSeconds, estimatedArrival }` | Citizen |
| `ambulanceReassigned` | `{ requestId, newEta }` | Citizen |
| `dispatchDelayed` | `{ message }` | Citizen |
| `dispatchAssigned` | `{ requestId, location, priority, eta }` | Driver |
| `statusUpdate` | `{ requestId, status, timestamp }` | Request room |
| `locationUpdate` | `{ ambulanceId, coordinates, timestamp }` | Request room |
| `etaUpdate` | `{ eta, etaSeconds, estimatedArrival }` | Citizen |
| `requestCompleted` | `{ requestId, completionTime }` | Request room |
| `requestCancelled` | `{ requestId }` | Ambulance room |
| `dispatchAllocated` | `{ requestId, ambulanceId, priority }` | Admins |
| `dispatchQueued` | `{ requestId, priority, timestamp }` | Admins |
| `ambulanceStatusChanged` | `{ ambulanceId, status }` | Dispatchers |

---

## Quick Start

```bash
# 1. Clone and install
npm install

# 2. Copy and configure environment
cp .env.example .env
# Edit .env — set MONGODB_URI, JWT_SECRET

# 3. Run in development
npm run dev

# 4. Run tests
npm test
```
