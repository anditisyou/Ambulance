# Emergency Response System — Production-Ready

A real-time emergency dispatch platform built with **Node.js · Express · MongoDB · Socket.IO**.

---

## Table of Contents
1. [Architecture](#architecture)
2. [Quick Start](#quick-start)
3. [Environment Variables](#environment-variables)
4. [API Reference](#api-reference)
5. [Role System](#role-system)
6. [Security Model](#security-model)
7. [Running Tests](#running-tests)
8. [Bug Fixes Applied](#bug-fixes-applied)
9. [Deployment](#deployment)

---

## Architecture

```
emergency-response-system/
├── index.js                    # Express server + MongoDB + Socket.IO bootstrap
├── controllers/                # Request handlers (one per domain)
│   ├── authController.js
│   ├── emergencyController.js
│   ├── dispatchController.js
│   ├── ambulanceController.js
│   ├── adminController.js
│   ├── analyticsController.js
│   └── medicalController.js
├── middleware/
│   ├── auth.js                 # JWT verification + token blacklist (Redis/memory)
│   ├── role.js                 # Role-based access control
│   ├── validate.js             # Lightweight request validator
│   └── errorHandler.js        # Global Express error handler
├── models/                     # Mongoose schemas
│   ├── User.js
│   ├── Ambulance.js
│   ├── EmergencyRequest.js
│   ├── DispatchLog.js
│   └── MedicalRecord.js
├── routes/                     # Express routers (one per domain)
├── utils/
│   ├── constants.js            # ALL enums — single source of truth
│   ├── AppError.js             # Custom operational error class
│   ├── haversine.js            # Great-circle distance calculation
│   ├── dispatchEngine.js       # Ambulance allocation logic
│   ├── etaCalculator.js        # OSRM routing with Haversine fallback
│   └── redisClient.js          # Redis initialisation with graceful fallback
└── tests/
    ├── system.test.js          # Utilities, constants, role middleware, edge cases
    ├── auth.test.js            # Auth controller (register, login, logout, JWT)
    ├── dispatch.test.js        # Dispatch controller + coordinate validation
    ├── ambulance.test.js       # Ambulance controller + status transitions
    ├── analytics-admin.test.js # Analytics + admin controllers
    └── security.test.js        # Security-specific regression tests
```

---

## Quick Start

```bash
# 1. Clone and install
git clone <your-repo>
cd emergency-response-system
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your MongoDB URI, JWT_SECRET, etc.

# 3. Start development server
npm run dev

# 4. Run tests
npm test
```

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `MONGODB_URI` | ✅ | MongoDB connection string |
| `JWT_SECRET` | ✅ | 64-byte random hex string (generate with `node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"`) |
| `JWT_EXPIRE` | — | Token lifetime (default: `7d`) |
| `PORT` | — | HTTP port (default: `3000`) |
| `NODE_ENV` | — | `development` or `production` |
| `REDIS_URL` | — | Redis connection URL (required for multi-instance deployments) |
| `CLOUDINARY_CLOUD_NAME` | — | Required for medical record file uploads |
| `CLOUDINARY_API_KEY` | — | Required for medical record file uploads |
| `CLOUDINARY_API_SECRET` | — | Required for medical record file uploads |
| `OSRM_ROUTING_URL` | — | OSRM server URL for road-network ETA (falls back to Haversine) |
| `FRONTEND_URL` | — | CORS origin (default: `http://localhost:3000`) |

---

## API Reference

### Auth  `/api/auth`
| Method | Path | Access | Description |
|---|---|---|---|
| POST | `/register` | Public | Register new user |
| POST | `/login` | Public | Login (email or phone) |
| GET | `/me` | Private | Get current user |
| POST | `/logout` | Private | Logout + revoke token |
| POST | `/refresh` | Private | Refresh JWT |

### Emergency  `/api/emergency`
| Method | Path | Access | Description |
|---|---|---|---|
| POST | `/` | Citizen | Create SOS request |
| GET | `/` | All roles | List requests (role-filtered) |
| GET | `/history` | Citizen | Own request history |
| GET | `/:id` | Related parties | Get single request |
| PUT | `/:id/accept` | Hospital | Accept request |
| PUT | `/:id/complete` | Driver | Mark completed |

### Dispatch  `/api/dispatch`
| Method | Path | Access | Description |
|---|---|---|---|
| POST | `/request` | Citizen | New emergency (auto-dispatches) |
| GET | `/active` | Citizen | Current active request |
| GET | `/assignments` | Driver | Current assignments |
| PUT | `/:id/response` | Driver | Accept/reject assignment |
| PATCH | `/:id/track` | Driver | Update location/status |
| DELETE | `/:id` | Citizen | Cancel request |

### Ambulances  `/api/ambulances`
| Method | Path | Access | Description |
|---|---|---|---|
| POST | `/` | Driver | Register or update ambulance |
| GET | `/` | Admin/Dispatcher/Driver | List ambulances |
| GET | `/:id` | Admin/Dispatcher/Driver | Get ambulance |
| PATCH | `/:id/status` | Driver/Admin | Update status |
| PATCH | `/:id/location` | Driver | Update GPS location |

### Admin  `/api/admin`
| Method | Path | Access | Description |
|---|---|---|---|
| GET | `/users` | Admin | List all users |
| GET | `/users/:id` | Admin | Get user by ID |
| PUT | `/users/:id/role` | Admin | Change user role |
| DELETE | `/users/:id` | Admin | Delete user |
| GET | `/ambulances` | Admin | List all ambulances |
| GET | `/stats` | Admin | System statistics |

### Analytics  `/api/analytics`
| Method | Path | Access | Description |
|---|---|---|---|
| GET | `/latency` | Admin | Response latency metrics |
| GET | `/performance` | Admin | Daily performance stats |
| GET | `/export` | Admin | Export data (JSON/CSV, max 10k rows) |

### Medical Records  `/api/medical`
| Method | Path | Access | Description |
|---|---|---|---|
| POST | `/upload` | Authenticated | Upload medical file |
| GET | `/:userId` | Owner/Hospital | Get user's records |
| GET | `/record/:id` | Owner/Hospital | Get single record |
| DELETE | `/record/:id` | Owner | Delete record |
| POST | `/share/:recordId` | Owner | Share with hospital |

---

## Role System

| Role | Description |
|---|---|
| `CITIZEN` | Creates emergency requests, views own history, manages own medical records |
| `DRIVER` | Receives dispatch assignments, updates ambulance location/status |
| `HOSPITAL` | Accepts emergency requests, views patient medical records |
| `DISPATCHER` | Views all requests and ambulances; manages dispatch queue |
| `ADMIN` | Full access to all resources + user management + analytics |

> **Note:** Users can self-register as CITIZEN, DRIVER, or HOSPITAL only.  
> DISPATCHER and ADMIN roles must be assigned by an existing ADMIN.

---

## Security Model

- **JWT** authentication with token blacklist (Redis in production, in-memory fallback in development)
- **httpOnly + SameSite:Strict** cookies — tokens never accessible from JavaScript
- **Token revocation** on logout — tokens invalidated immediately, not just at expiry
- **bcrypt** password hashing with work factor 12 (OWASP 2024 minimum)
- **Role-based access control** on every route — no unauthenticated or wrong-role access
- **Input sanitisation** — all pagination parameters clamped, descriptions truncated, coordinates range-validated
- **Export DoS prevention** — analytics export hard-capped at 10,000 rows
- **Generic error messages** for auth failures — prevents user enumeration
- **Helmet** security headers on all responses
- **Rate limiting** — 200 requests per 15 minutes per IP

---

## Running Tests

```bash
# All tests
npm test

# With coverage
npm run test:cov

# Single file
npx jest tests/auth.test.js

# Pure Node (no jest needed for util/logic tests)
node -e "require('./tests/system.test.js')"
```

### Test Coverage

| File | Cases | Coverage Area |
|---|---|---|
| `system.test.js` | 27 | Haversine, AppError, constants, role middleware, edge cases |
| `auth.test.js` | 25 | Register (10 validation cases), login, logout, JWT security |
| `dispatch.test.js` | 20 | Coordinates (9 bad inputs), priority/type fallbacks, ETA |
| `ambulance.test.js` | 20 | 12 transition pairs, updateStatus auth, 50m GPS threshold |
| `analytics-admin.test.js` | 25 | Export cap, CSV format, date validation, pagination, self-protection |
| `security.test.js` | 20 | Token extraction, password exposure, role injection, cookie config |

**Total: 137 test cases across 6 test files**

---

## Bug Fixes Applied

27 bugs were identified and fixed from the original codebase:

| # | Severity | Description |
|---|---|---|
| 1 | 🔴 CRITICAL | `index.js` was a Cloudinary sample — no Express server existed |
| 2 | 🔴 CRITICAL | `DispatchLog` used in `emergencyController` without being imported |
| 3 | 🔴 CRITICAL | `mongoose` used for transactions in `emergencyController` without import |
| 4 | 🔴 CRITICAL | `mongoose` used for transactions in `medicalController` without import |
| 5 | 🔴 CRITICAL | `REQUEST_STATUS.ACCEPTED` doesn't exist — saves `undefined` to DB |
| 6 | 🔴 CRITICAL | `REQUEST_PRIORITY.includes()` called on Object (not array) → TypeError |
| 7 | 🔴 CRITICAL | `REQUEST_TYPES.includes()` called on Object (not array) → TypeError |
| 8 | 🔴 CRITICAL | `.map(req => ...)` shadows outer Express `req` parameter |
| 9 | 🔴 SECURITY | Live MongoDB + Cloudinary credentials committed to `.env.example` |
| 10 | 🟠 SECURITY | Token accepted from `?token=` query param → logs in access logs |
| 11 | 🟠 SECURITY | `startsWith('Bearer')` missing trailing space — malformed check |
| 12 | 🟠 SECURITY | In-memory blacklist not shared across server instances |
| 13 | 🟡 SECURITY | bcrypt work factor 10 (OWASP minimum is 12) |
| 14 | 🟡 SECURITY | No row limit on analytics export → OOM / DoS |
| 15 | 🟡 LOGIC | `requireAllRoles` always fails for multiple required roles |
| 16 | 🟡 LOGIC | Ambulance freed before next-ambulance search — race condition window |
| 17 | 🟡 PERF | N+1 query — 1 DB call per request document to fetch driver info |
| 18 | 🟡 MAINTAINABILITY | `calculateDistance` copy-pasted in 2 controllers |
| 19 | 🟡 LOGIC | Two conflicting compound indexes on EmergencyRequest |
| 20 | 🟡 LOGIC | Duplicate `role` index on User model |
| 21 | 🟡 LOGIC | Hardcoded status strings in `adminController` instead of constants |
| 22 | 🟡 LOGIC | Incorrect `$cond` pattern for null date check in analytics pipeline |
| 23 | 🟡 COMPAT | `$percentile` requires MongoDB 7.0+ — fails silently on older clusters |
| 24 | 🟡 LOGIC | `logs[]` array used in controllers but not defined in DispatchLog schema |
| 25 | 🟡 LOGIC | File metadata fields saved in controller but missing from MedicalRecord schema |
| 26 | 🟡 LOGIC | Ambulance `capacity` default = 0, which is never valid |
| 27 | 🟡 DX | Manual `updatedAt` bookkeeping instead of `timestamps: true` |

---

## Deployment

### Docker (recommended)

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 3000
CMD ["node", "index.js"]
```

### Production checklist

- [ ] Set `NODE_ENV=production`
- [ ] Generate strong `JWT_SECRET` (64 hex bytes)
- [ ] Provision Redis for token blacklist + Socket.IO adapter
- [ ] Use MongoDB Atlas (replica set) or self-hosted replica set
- [ ] Set `CLOUDINARY_*` vars for medical file storage
- [ ] Configure `OSRM_ROUTING_URL` or swap in a commercial routing API
- [ ] Place behind Nginx/ALB with SSL termination
- [ ] Enable MongoDB read replica for analytics queries
- [ ] Set up log aggregation (Datadog / CloudWatch / ELK)

### Scaling to multiple instances

When running multiple Node.js pods:
1. **Token blacklist**: Redis is required — in-memory does not persist across instances
2. **Socket.IO**: Install `socket.io-redis` adapter so events reach clients on all pods
3. **File uploads**: Multer writes to OS temp dir — works fine with Cloudinary since files are streamed up and temp deleted immediately
