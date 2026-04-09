# ðŸš‘ Emergency Response System â€” Production-Grade

A **production-ready** real-time emergency dispatch platform built with **Node.js Â· Express Â· MongoDB Â· Socket.IO Â· Redis**.

## âœ¨ Production-Grade Features

### ðŸ”§ Core Infrastructure
- **Advanced Rate Limiting**: Redis-backed tiered rate limiting with sliding windows
- **Real Alert Delivery**: Slack, email, and webhook notifications for system alerts
- **Health Checks**: Comprehensive `/health` endpoint with system diagnostics
- **Metrics Dashboard**: Real-time visualization at `/metrics-dashboard`
- **Load Testing**: 1000-user simulation with detailed performance analysis

### ðŸ›¡ï¸ Security & Observability
- **Enterprise Security**: Helmet.js, CORS, MongoDB sanitization, CSRF protection
- **Advanced Monitoring**: Prometheus metrics export, structured logging
- **Alert Management**: Multi-channel alerting with cooldown prevention
- **Audit Compliance**: Immutable audit logs with tamper-proof records

### âš¡ Performance & Scalability
- **Horizontal Scaling**: Multi-instance deployment with Redis session sharing
- **Queue Management**: BullMQ with priority queues and retry logic
- **Load Shedding**: Graceful degradation under extreme load (10k+ users)
- **Database Optimization**: Connection pooling, indexing, and query optimization

---

## Table of Contents
1. [System Vision](#system-vision)
2. [Architecture](#architecture)
3. [Quick Start](#quick-start)
4. [Production Deployment](#production-deployment)
5. [Environment Variables](#environment-variables)
6. [API Reference](#api-reference)
7. [Monitoring & Alerting](#monitoring--alerting)
8. [Load Testing](#load-testing)
9. [Security Model](#security-model)
10. [Running Tests](#running-tests)
11. [Deployment](#deployment)

---

## System Vision

The ERS mission and scalability blueprint is documented in [SYSTEM_VISION.md](./SYSTEM_VISION.md).
It captures the core motto, target users, current and future scale targets, architecture layers, and growth strategy.

---

## Architecture

```
emergency-response-system/
â”œâ”€â”€ index.js                    # Express server + MongoDB + Socket.IO bootstrap
â”œâ”€â”€ controllers/                # Request handlers (one per domain)
â”‚   â”œâ”€â”€ authController.js
â”‚   â”œâ”€â”€ emergencyController.js
â”‚   â”œâ”€â”€ dispatchController.js
â”‚   â”œâ”€â”€ ambulanceController.js
â”‚   â”œâ”€â”€ adminController.js
â”‚   â”œâ”€â”€ analyticsController.js
â”‚   â””â”€â”€ medicalController.js
â”œâ”€â”€ middleware/
â”‚   â”œâ”€â”€ auth.js                 # JWT verification + token blacklist (Redis/memory)
â”‚   â”œâ”€â”€ role.js                 # Role-based access control
â”‚   â”œâ”€â”€ validate.js             # Lightweight request validator
â”‚   â””â”€â”€ errorHandler.js        # Global Express error handler
â”œâ”€â”€ models/                     # Mongoose schemas
â”‚   â”œâ”€â”€ User.js
â”‚   â”œâ”€â”€ Ambulance.js
â”‚   â”œâ”€â”€ EmergencyRequest.js
â”‚   â”œâ”€â”€ DispatchLog.js
â”‚   â””â”€â”€ MedicalRecord.js
â”œâ”€â”€ routes/                     # Express routers (one per domain)
â”œâ”€â”€ utils/
â”‚   â”œâ”€â”€ constants.js            # ALL enums â€” single source of truth
â”‚   â”œâ”€â”€ AppError.js             # Custom operational error class
â”‚   â”œâ”€â”€ haversine.js            # Great-circle distance calculation
â”‚   â”œâ”€â”€ dispatchEngine.js       # Ambulance allocation logic
â”‚   â”œâ”€â”€ etaCalculator.js        # OSRM routing with Haversine fallback
â”‚   â””â”€â”€ redisClient.js          # Redis initialisation with graceful fallback
â””â”€â”€ tests/
    â”œâ”€â”€ system.test.js          # Utilities, constants, role middleware, edge cases
    â”œâ”€â”€ auth.test.js            # Auth controller (register, login, logout, JWT)
    â”œâ”€â”€ dispatch.test.js        # Dispatch controller + coordinate validation
    â”œâ”€â”€ ambulance.test.js       # Ambulance controller + status transitions
    â”œâ”€â”€ analytics-admin.test.js # Analytics + admin controllers
    â””â”€â”€ security.test.js        # Security-specific regression tests
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
| `MONGODB_URI` | âœ… | MongoDB connection string |
| `JWT_SECRET` | âœ… | 64-byte random hex string (generate with `node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"`) |
| `JWT_EXPIRE` | â€” | Token lifetime (default: `7d`) |
| `PORT` | â€” | HTTP port (default: `3000`) |
| `NODE_ENV` | â€” | `development` or `production` |
| `REDIS_URL` | â€” | Redis connection URL (required for multi-instance deployments) |
| `CLOUDINARY_CLOUD_NAME` | â€” | Required for medical record file uploads |
| `CLOUDINARY_API_KEY` | â€” | Required for medical record file uploads |
| `CLOUDINARY_API_SECRET` | â€” | Required for medical record file uploads |
| `OSRM_ROUTING_URL` | â€” | OSRM server URL for road-network ETA (falls back to Haversine) |
| `FRONTEND_URL` | â€” | CORS origin (default: `http://localhost:3000`) |

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
- **httpOnly + SameSite:Strict** cookies â€” tokens never accessible from JavaScript
- **Token revocation** on logout â€” tokens invalidated immediately, not just at expiry
- **bcrypt** password hashing with work factor 12 (OWASP 2024 minimum)
- **Role-based access control** on every route â€” no unauthenticated or wrong-role access
- **Input sanitisation** â€” all pagination parameters clamped, descriptions truncated, coordinates range-validated
- **Export DoS prevention** â€” analytics export hard-capped at 10,000 rows
- **Generic error messages** for auth failures â€” prevents user enumeration
- **Helmet** security headers on all responses
- **Rate limiting** â€” 200 requests per 15 minutes per IP

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

## Monitoring & Alerting

### Real-Time Metrics Dashboard
Access live system metrics at: `http://localhost:3000/metrics-dashboard`

**Key Metrics Monitored:**
- Request rate and error rates
- Response time percentiles (P50, P95, P99)
- Queue depth and dispatch performance
- Memory and CPU usage
- Database connection health

### Alert Channels
- **Slack**: Real-time alerts to configured channels
- **Email**: Critical error notifications
- **Webhooks**: Integration with external monitoring systems
- **Cooldown Protection**: Prevents alert spam (5-minute windows)

### Health Check Endpoint
```bash
curl http://localhost:3000/health
# Returns comprehensive system health status
```

---

## Load Testing

### Quick Load Test (100 users, 1 minute)
```bash
npm run test:load:quick
```

### Full Production Load Test (1000 users, 5 minutes)
```bash
npm run test:load:full
```

### Custom Load Test
```bash
node scripts/load-test.js [duration_seconds] [max_users]
```

**Load Test Features:**
- Multi-threaded user simulation
- Realistic user behavior patterns
- Detailed performance metrics
- Automated pass/fail criteria
- Result export to JSON files

---

## Production Deployment

### Environment Setup
```bash
# Required environment variables
cp .env.example .env.production
# Edit .env.production with production values

# Install dependencies
npm install

# Run production build
npm run build
```

### Docker Deployment
```bash
# Build production image
docker build -t ers:latest .

# Run with docker-compose
docker-compose -f docker-compose.prod.yml up -d
```

### Key Production URLs
- **Application**: `https://your-domain.com`
- **API Docs**: `https://your-domain.com/api-docs`
- **Metrics**: `https://your-domain.com/metrics-dashboard`
- **Health Check**: `https://your-domain.com/health`
- **Readiness Check**: `https://your-domain.com/ready`

`/health` is a lightweight liveness endpoint (always HTTP 200 with status payload).
`/ready` is a strict dependency gate (HTTP 503 when DB/Redis dependencies are not ready).

### Scaling Configuration
```javascript
// Auto-scaling triggers
- CPU > 70%: Scale up instances
- Memory > 80%: Scale up instances
- Request rate > 1000/min: Scale up
- Queue depth > 100: Scale up

// Database scaling
- MongoDB connection pool: 100 max
- Redis cluster with replication
- Read replicas for analytics
```

---

## Bug Fixes Applied

27 bugs were identified and fixed from the original codebase:

| # | Severity | Description |
|---|---|---|
| 1 | ðŸ”´ CRITICAL | `index.js` was a Cloudinary sample â€” no Express server existed |
| 2 | ðŸ”´ CRITICAL | `DispatchLog` used in `emergencyController` without being imported |
| 3 | ðŸ”´ CRITICAL | `mongoose` used for transactions in `emergencyController` without import |
| 4 | ðŸ”´ CRITICAL | `mongoose` used for transactions in `medicalController` without import |
| 5 | ðŸ”´ CRITICAL | `REQUEST_STATUS.ACCEPTED` doesn't exist â€” saves `undefined` to DB |
| 6 | ðŸ”´ CRITICAL | `REQUEST_PRIORITY.includes()` called on Object (not array) â†’ TypeError |
| 7 | ðŸ”´ CRITICAL | `REQUEST_TYPES.includes()` called on Object (not array) â†’ TypeError |
| 8 | ðŸ”´ CRITICAL | `.map(req => ...)` shadows outer Express `req` parameter |
| 9 | ðŸ”´ SECURITY | Live MongoDB + Cloudinary credentials committed to `.env.example` |
| 10 | ðŸŸ  SECURITY | Token accepted from `?token=` query param â†’ logs in access logs |
| 11 | ðŸŸ  SECURITY | `startsWith('Bearer')` missing trailing space â€” malformed check |
| 12 | ðŸŸ  SECURITY | In-memory blacklist not shared across server instances |
| 13 | ðŸŸ¡ SECURITY | bcrypt work factor 10 (OWASP minimum is 12) |
| 14 | ðŸŸ¡ SECURITY | No row limit on analytics export â†’ OOM / DoS |
| 15 | ðŸŸ¡ LOGIC | `requireAllRoles` always fails for multiple required roles |
| 16 | ðŸŸ¡ LOGIC | Ambulance freed before next-ambulance search â€” race condition window |
| 17 | ðŸŸ¡ PERF | N+1 query â€” 1 DB call per request document to fetch driver info |
| 18 | ðŸŸ¡ MAINTAINABILITY | `calculateDistance` copy-pasted in 2 controllers |
| 19 | ðŸŸ¡ LOGIC | Two conflicting compound indexes on EmergencyRequest |
| 20 | ðŸŸ¡ LOGIC | Duplicate `role` index on User model |
| 21 | ðŸŸ¡ LOGIC | Hardcoded status strings in `adminController` instead of constants |
| 22 | ðŸŸ¡ LOGIC | Incorrect `$cond` pattern for null date check in analytics pipeline |
| 23 | ðŸŸ¡ COMPAT | `$percentile` requires MongoDB 7.0+ â€” fails silently on older clusters |
| 24 | ðŸŸ¡ LOGIC | `logs[]` array used in controllers but not defined in DispatchLog schema |
| 25 | ðŸŸ¡ LOGIC | File metadata fields saved in controller but missing from MedicalRecord schema |
| 26 | ðŸŸ¡ LOGIC | Ambulance `capacity` default = 0, which is never valid |
| 27 | ðŸŸ¡ DX | Manual `updatedAt` bookkeeping instead of `timestamps: true` |

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
1. **Token blacklist**: Redis is required â€” in-memory does not persist across instances
2. **Socket.IO**: Install `socket.io-redis` adapter so events reach clients on all pods
3. **File uploads**: Multer writes to OS temp dir â€” works fine with Cloudinary since files are streamed up and temp deleted immediately
