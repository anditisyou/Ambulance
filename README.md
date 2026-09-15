<!--
╔══════════════════════════════════════════════════════════════════════╗
║  THE OBSERVATORY · 救急システム                                      ║
║  Emergency Response System                                           ║
║  Where every second becomes a decision.                              ║
╚══════════════════════════════════════════════════════════════════════╝
-->

<div align="center">

<img src="https://capsule-render.vercel.app/api?type=waving&color=0:05080D,50:7F1018,100:05080D&height=190&section=header&text=THE%20EMERGENCY%20OBSERVATORY&fontSize=42&fontColor=F4E7D0&fontAlignY=43&desc=救急%20%C2%B7%20REAL-TIME%20EMERGENCY%20RESPONSE&descSize=15&descAlignY=67&animation=fadeIn" width="100%" alt="The Emergency Observatory" />

<br/>

<sub><i>観察する ・ 構築する ・ 応答する</i></sub>

<br/><br/>

[![Node.js](https://img.shields.io/badge/NODE.JS-05080D?style=for-the-badge&logo=node.js&logoColor=F4E7D0)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/EXPRESS-05080D?style=for-the-badge&logo=express&logoColor=F4E7D0)](https://expressjs.com/)
[![MongoDB](https://img.shields.io/badge/MONGODB-05080D?style=for-the-badge&logo=mongodb&logoColor=7CB342)](https://www.mongodb.com/)
[![Socket.IO](https://img.shields.io/badge/SOCKET.IO-05080D?style=for-the-badge&logo=socketdotio&logoColor=F4E7D0)](https://socket.io/)
[![Redis](https://img.shields.io/badge/REDIS-05080D?style=for-the-badge&logo=redis&logoColor=DC382D)](https://redis.io/)

<br/>

<a href="#-01--observe"><img src="https://img.shields.io/badge/01%20OBSERVE-E63946?style=for-the-badge&labelColor=05080D" /></a>
<a href="#-02--build"><img src="https://img.shields.io/badge/02%20BUILD-F4E7D0?style=for-the-badge&labelColor=05080D" /></a>
<a href="#-03--research"><img src="https://img.shields.io/badge/03%20RESEARCH-F4E7D0?style=for-the-badge&labelColor=05080D" /></a>
<a href="#-04--respond"><img src="https://img.shields.io/badge/04%20RESPOND-F4E7D0?style=for-the-badge&labelColor=05080D" /></a>
<a href="#-05--beyond"><img src="https://img.shields.io/badge/05%20BEYOND-F4E7D0?style=for-the-badge&labelColor=05080D" /></a>

<br/><br/>

<img src="https://img.shields.io/badge/STATUS-ONLINE-E63946?style=for-the-badge&labelColor=05080D" />
<img src="https://img.shields.io/badge/VERSION-2.0.0-8B0000?style=for-the-badge&labelColor=05080D" />
<img src="https://img.shields.io/badge/LICENSE-ISC-F4E7D0?style=for-the-badge&labelColor=05080D" />

</div>

---

<div align="center">
<table>
<tr>
<td width="62%" valign="top">

<br/>

# THE<br/>RESPONSE<br/>SYSTEM

<sub><code>KYŪKYŪ — EMERGENCY RESPONSE</code></sub>

<br/><br/>

**Where technology meets urgency.**  
**Where every second becomes a decision.**

<br/>

A production-ready emergency dispatch platform that connects citizens, ambulance drivers, hospitals, dispatchers and administrators through real-time coordination.

<br/><br/>

**[→ ENTER THE SYSTEM](#-01--observe)**

</td>
<td width="38%" valign="top">

### `01 — 観察する`
### **OBSERVE**
<sub>See the emergency as it unfolds.</sub>

<br/>

### `02 — 構築する`
### **BUILD**
<sub>Route, dispatch and coordinate.</sub>

<br/>

### `03 — 研究する`
### **RESEARCH**
<sub>Measure what the system is doing.</sub>

<br/>

### `04 — 応答する`
### **RESPOND**
<sub>Move the right resource, fast.</sub>

<br/>

### `05 — 余白`
### **BEYOND**
<sub>Design for the failure nobody planned for.</sub>

</td>
</tr>
</table>
</div>

---

<a id="01--observe"></a>
## `01` · 観察する · **OBSERVE**

> *Understand the emergency before the system responds.*

### What is this?

The **Emergency Response System (ERS)** is a real-time dispatch platform designed to reduce the time between an emergency request and coordinated medical response.

The platform supports **one-click emergency requests, GPS-based ambulance discovery, automated dispatch, real-time tracking, ETA updates, hospital coordination, medical records, notifications and operational analytics.**

### The response loop

```text
┌──────────┐       ┌────────────┐       ┌────────────┐
│  CITIZEN │ ───→  │   DISPATCH │ ───→  │  AMBULANCE │
└──────────┘       └────────────┘       └─────┬──────┘
      ↑                    │                  │
      │                    ↓                  ↓
      │             ┌────────────┐      ┌────────────┐
      └──────────── │  HOSPITAL  │ ←─── │ REAL-TIME  │
                    └────────────┘      │  TRACKING  │
                                        └────────────┘
```

### Core capabilities

| System | Capability |
|---|---|
| `SOS` | Create and manage emergency requests |
| `DISPATCH` | Priority-based ambulance allocation |
| `GPS` | Live ambulance location and distance calculation |
| `ETA` | Road-network ETA with routing fallback |
| `TRACKING` | Real-time status and location updates |
| `HOSPITAL` | Request acceptance and patient coordination |
| `MEDICAL` | Secure medical record upload and sharing |
| `ANALYTICS` | Performance, latency and operational metrics |
| `ALERTING` | Slack, email and webhook system alerts |

---

<a id="02--build"></a>
## `02` · 構築する · **BUILD**

> *Engineering the path from SOS to care.*

### Architecture

```text
                         ┌──────────────────────┐
                         │       CLIENTS        │
                         │ Citizen · Driver     │
                         │ Hospital · Admin     │
                         └──────────┬───────────┘
                                    │
                              HTTP / WebSocket
                                    │
                         ┌──────────▼───────────┐
                         │   EXPRESS / NODE.JS  │
                         │  Auth · Routes · API │
                         └──────────┬───────────┘
                                    │
              ┌─────────────────────┼─────────────────────┐
              │                     │                     │
       ┌──────▼──────┐      ┌──────▼──────┐      ┌──────▼──────┐
       │  DISPATCH   │      │   REALTIME  │      │  ANALYTICS  │
       │ Engine/Queue│      │ Socket.IO   │      │ Metrics     │
       └──────┬──────┘      └──────┬──────┘      └──────┬──────┘
              │                     │                     │
              └─────────────────────┼─────────────────────┘
                                    │
                    ┌───────────────┼───────────────┐
                    │                               │
             ┌──────▼──────┐                 ┌──────▼──────┐
             │   MongoDB   │                 │    Redis    │
             │ Persistence │                 │ Queue/Cache │
             └─────────────┘                 └─────────────┘
```

### Project structure

```text
Ambulance/
├── controllers/          # Auth, emergency, dispatch, ambulance, admin, analytics
├── middleware/           # JWT, RBAC, validation, sessions, uploads, errors
├── models/               # User, Ambulance, EmergencyRequest, Hospital, MedicalRecord
├── routes/               # Domain-specific API routers
├── utils/                # Dispatch engine, ETA, queues, caching, monitoring
├── public/                # Citizen, driver, hospital and admin interfaces
├── tests/                 # Unit, integration, security and system tests
├── scripts/               # Load tests, migrations and validation utilities
├── config/                # Swagger and application configuration
├── server.js              # Application/server integration
├── index.js               # Application bootstrap
├── docker-compose.yml     # Container orchestration
├── dockerfile             # Production container image
└── README.md              # You are here
```

---

<a id="03--research"></a>
## `03` · 研究する · **RESEARCH**

> *Measure the system. Find the bottleneck. Improve the response.*

### Technology stack

| Layer | Technologies |
|---|---|
| **Runtime** | Node.js 18+ |
| **API** | Express.js |
| **Database** | MongoDB · Mongoose |
| **Realtime** | Socket.IO |
| **Cache / Queue** | Redis · BullMQ |
| **Authentication** | JWT · httpOnly cookies · bcrypt |
| **Routing** | OSRM · Haversine fallback |
| **Uploads** | Multer · Cloudinary |
| **Notifications** | Nodemailer · Twilio · Slack/Webhooks |
| **Observability** | Winston · Prometheus metrics |
| **Security** | Helmet · CORS · MongoDB sanitization · rate limiting |
| **Testing** | Jest · Supertest · MongoDB Memory Server |
| **Deployment** | Docker · Nginx · Render-ready configuration |

### Dispatch intelligence

The dispatch layer combines **distance, availability, priority and ambulance state** to determine an appropriate response path. Geospatial calculations use the Haversine formula, while ETA calculation can use road-network routing and fall back when routing is unavailable.

### Resilience by design

```text
           NORMAL LOAD
               │
               ▼
        ┌──────────────┐
        │ Dispatch     │
        │ Queue        │
        └──────┬───────┘
               │
        ┌──────▼───────┐
        │ Available    │
        │ Ambulance    │
        └──────────────┘

        HIGH LOAD / FAILURE
               │
        ┌──────▼────────┐
        │ Rate Limiter  │
        ├───────────────┤
        │ Load Shedder  │
        ├───────────────┤
        │ Circuit Break │
        ├───────────────┤
        │ Retry / Queue │
        └───────────────┘
```

### Security model

- JWT authentication with revocation support
- `httpOnly` + `SameSite: Strict` cookies
- Role-based access control across protected routes
- Password hashing with bcrypt
- Helmet security headers
- CORS controls
- Input and coordinate validation
- Pagination limits and analytics export caps
- Rate limiting against abusive request volume
- Immutable audit logging for sensitive operations

---

<a id="04--respond"></a>
## `04` · 応答する · **RESPOND**

> *From a citizen's SOS to a completed emergency request.*

### 01 · REQUEST

A citizen creates an emergency request through the public interface.

### 02 · LOCATE

The system receives the emergency coordinates and evaluates available response resources.

### 03 · DISPATCH

The dispatch engine and queue determine an appropriate ambulance response.

### 04 · ACCEPT

The driver receives the assignment and can accept or reject the response.

### 05 · TRACK

Ambulance location and response state can be updated in real time through Socket.IO-backed coordination.

### 06 · ARRIVE

The patient is transported while ETA and emergency state remain visible to the relevant roles.

### 07 · COMPLETE

The driver completes the request and the system retains operational history for later analysis.

---

### Role matrix

| Role | Responsibility |
|---|---|
| `CITIZEN` | Create emergencies, track requests, view history and manage own medical records |
| `DRIVER` | Receive assignments, update ambulance status and GPS location |
| `HOSPITAL` | Accept emergency requests and access shared patient records |
| `DISPATCHER` | Monitor requests and ambulances, manage dispatch operations |
| `ADMIN` | User management, system oversight and analytics |

> `CITIZEN`, `DRIVER` and `HOSPITAL` can self-register. `DISPATCHER` and `ADMIN` roles require administrative assignment.

---

### API surface

<details>
<summary><b>Authentication · /api/auth</b></summary>

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/register` | Register user |
| `POST` | `/login` | Login with email or phone |
| `GET` | `/me` | Current user |
| `POST` | `/logout` | Revoke session |
| `POST` | `/refresh` | Refresh JWT |

</details>

<details>
<summary><b>Emergency · /api/emergency</b></summary>

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/` | Create SOS request |
| `GET` | `/` | List role-filtered requests |
| `GET` | `/history` | Citizen request history |
| `GET` | `/:id` | Retrieve emergency |
| `PUT` | `/:id/accept` | Hospital accepts request |
| `PUT` | `/:id/complete` | Driver completes request |

</details>

<details>
<summary><b>Dispatch · /api/dispatch</b></summary>

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/request` | Create and auto-dispatch emergency |
| `GET` | `/active` | Current active request |
| `GET` | `/assignments` | Driver assignments |
| `PUT` | `/:id/response` | Accept/reject assignment |
| `PATCH` | `/:id/track` | Update location/status |
| `DELETE` | `/:id` | Cancel request |

</details>

<details>
<summary><b>Ambulances · /api/ambulances</b></summary>

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/` | Register/update ambulance |
| `GET` | `/` | List ambulances |
| `GET` | `/:id` | Retrieve ambulance |
| `PATCH` | `/:id/status` | Update ambulance status |
| `PATCH` | `/:id/location` | Update GPS location |

</details>

<details>
<summary><b>Admin · /api/admin</b></summary>

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/users` | List users |
| `GET` | `/users/:id` | Retrieve user |
| `PUT` | `/users/:id/role` | Change role |
| `DELETE` | `/users/:id` | Delete user |
| `GET` | `/ambulances` | List ambulances |
| `GET` | `/stats` | System statistics |

</details>

<details>
<summary><b>Analytics · /api/analytics</b></summary>

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/latency` | Response latency |
| `GET` | `/performance` | Daily performance |
| `GET` | `/export` | JSON/CSV export with row cap |

</details>

<details>
<summary><b>Medical Records · /api/medical</b></summary>

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/upload` | Upload medical file |
| `GET` | `/:userId` | Retrieve records |
| `GET` | `/record/:id` | Retrieve one record |
| `DELETE` | `/record/:id` | Delete record |
| `POST` | `/share/:recordId` | Share with hospital |

</details>

---

<a id="05--beyond"></a>
## `05` · 余白 · **BEYOND**

> *The system should remain useful when the situation stops being predictable.*

### Production observability

```text
REQUEST RATE ────────┐
ERROR RATE ──────────┤
P50 / P95 / P99 ─────┤
QUEUE DEPTH ─────────┼──→ METRICS DASHBOARD
MEMORY / CPU ────────┤
DB HEALTH ───────────┘
```

Live metrics are available at:

`/metrics-dashboard`

Health and readiness endpoints:

```bash
curl http://localhost:3000/health
curl http://localhost:3000/ready
```

### Load testing

```bash
# Default load test
npm run test:load

# 100 simulated users · 60 seconds
npm run test:load:quick

# 1000 simulated users · 5 minutes
npm run test:load:full
```

### Tests

The repository includes unit, integration, system and security coverage.

```bash
npm test
npm run test:integration
npm run test:all
npm run test:cov
npm run lint
```

### Deployment

```bash
# Install
npm install

# Development
npm run dev

# Production
npm start
```

Docker:

```bash
docker build -t ers:latest .
docker-compose up -d
```

### Environment

| Variable | Required | Purpose |
|---|:---:|---|
| `MONGODB_URI` | ✅ | MongoDB connection |
| `JWT_SECRET` | ✅ | JWT signing secret |
| `JWT_EXPIRE` | — | Token lifetime; defaults to `7d` |
| `PORT` | — | HTTP port; defaults to `3000` |
| `NODE_ENV` | — | `development` / `production` |
| `REDIS_URL` | — | Redis connection for multi-instance operation |
| `CLOUDINARY_CLOUD_NAME` | — | Medical file storage |
| `CLOUDINARY_API_KEY` | — | Cloudinary authentication |
| `CLOUDINARY_API_SECRET` | — | Cloudinary authentication |
| `OSRM_ROUTING_URL` | — | Road-network routing endpoint |
| `FRONTEND_URL` | — | CORS origin |

---

## SYSTEM NOTES

Additional engineering documentation lives in:

- [`SYSTEM_VISION.md`](./SYSTEM_VISION.md) — system mission and scale blueprint
- [`API_DOCS.md`](./API_DOCS.md) — API documentation
- [`REALTIME_TRACKING.md`](./REALTIME_TRACKING.md) — real-time tracking architecture
- [`PERFORMANCE_OPTIMIZATIONS.md`](./PERFORMANCE_OPTIMIZATIONS.md) — performance work
- [`PRODUCTION_AUDIT.md`](./PRODUCTION_AUDIT.md) — production audit and hardening
- [`DEPLOYMENT_GUIDE.md`](./DEPLOYMENT_GUIDE.md) — deployment guidance

---

<div align="center">

### `現在観察中 · NOW OBSERVING`

**Emergency response is not just about speed.**  
**It is about making the right decision when time is disappearing.**

<br/>

<a href="https://ambulance-ykea.onrender.com">
<img src="https://img.shields.io/badge/→%20LIVE%20SYSTEM-8B0000?style=for-the-badge&labelColor=05080D" />
</a>

<br/><br/>

<sub><i>救急 · 構築する · 観察する · 応答する</i></sub>

<br/><br/>

<img src="https://capsule-render.vercel.app/api?type=waving&color=0:05080D,50:7F1018,100:05080D&height=120&section=footer&text=%E6%95%91%E6%80%A5&fontSize=30&fontColor=F4E7D0&fontAlignY=70&animation=fadeIn" width="100%" alt="Emergency Response" />

<sub><i>▓▓▓▓▓▓▓▓▓▓  response_channel.open  [ ONLINE ]  ▓▓▓▓▓▓▓▓▓▓</i></sub>

</div>

<!-- Built for moments when every second matters. -->
