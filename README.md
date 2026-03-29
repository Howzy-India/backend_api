# Howzy Backend API

**Firebase Project:** `howzy-api`
**Org:** `gkitsolutions29-org`

Standalone Firebase Cloud Functions backend for the Howzy real estate platform.
This is the **single shared backend** for all Howzy clients:
- `frontend-web` (React/Vite → hosted on `howzy-web`)
- Mobile apps (iOS/Android — future)
- Any other 3rd-party integrations

## Architecture

```
howzy-api (Firebase Project)
├── Cloud Functions
│   ├── api          — Express HTTP API (all REST endpoints)
│   ├── createUserWithRole, updateUserRole, setUserDisabled, deleteUser
│   ├── submitBuilderForApproval, approveBuilder, rejectBuilder, deleteBuilderIfUnapproved
│   └── bootstrapSuperAdmin
├── Firestore        — Primary database
├── Firebase Auth    — Google Sign-In + custom role claims
└── Firebase Storage — Attendance photos, property media, submission docs
```

**Clients connect to `howzy-api` using the Firebase SDK config from this project.**

---

## HTTP API Endpoints

### Public
| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| GET | `/projects` | All projects + approved submissions |
| GET | `/projects/:id` | Single project |
| GET | `/public/stats` | Platform stats |
| POST | `/enquiries` | Create enquiry |
| POST | `/client/login-track` | Track client login |

### Authenticated (Bearer token required)
| Method | Path | Role |
|--------|------|------|
| GET | `/leads` | admin/super_admin |
| POST | `/leads` | any |
| POST | `/leads/auto-assign` | admin/super_admin |
| PATCH | `/leads/:id` | agent/admin |
| GET | `/earnings` | admin/super_admin |
| GET | `/submissions` | admin/super_admin |
| POST | `/submissions` | partner/admin |
| PATCH | `/submissions/:id/status` | admin/super_admin |
| GET | `/partner/submissions` | partner |
| GET | `/enquiries` | admin/super_admin |
| PATCH | `/enquiries/:id/status` | admin/super_admin |
| GET | `/enquiries/:id/timeline` | any auth |
| POST | `/admin/enquiries/:id/assign` | admin/super_admin |
| PATCH | `/partner/enquiries/:id/status` | partner/admin |
| GET | `/admin/sales-team` | admin/super_admin |
| GET | `/admin/partners` | admin/super_admin |
| GET | `/admin/client-logins` | admin/super_admin |
| GET | `/admin/client-360/:email` | admin/super_admin |
| GET | `/client/enquiries` | client/admin |
| GET | `/pilot/assigned-enquiries` | agent/admin |
| GET | `/partner/assigned-enquiries` | partner/admin |
| POST | `/attendance/punch-in` | agent/partner/admin |
| POST | `/attendance/punch-out` | agent/partner/admin |
| GET | `/attendance` | agent/partner/admin |
| GET | `/attendance/history` | agent/partner/admin |
| POST | `/attendance/location` | agent/partner/admin |
| GET | `/auth/google/url` | any |
| GET | `/auth/google/callback` | any |
| GET/POST | `/calendar/events` | any auth |
| GET | `/calendar/status` | any auth |

## Firestore Collections

| Collection | Description |
|---|---|
| `users` | All platform users with roles |
| `projects` | Property listings |
| `leads` | Sales leads |
| `bookings` | Closed bookings / earnings |
| `submissions` | Partner onboarding submissions |
| `enquiries` | Client enquiries on properties |
| `enquiry_timeline` | Audit trail for enquiry actions |
| `client_logins` | Client login tracking |
| `builders` | Builder records |
| `approvals` | Builder approval requests |
| `auditLogs` | System audit log |
| `attendance` | Agent/partner punch-in/out records |
| `location_logs` | Real-time GPS location logs |

## CORS

Allowed origins (edit `src/api/index.ts` → `ALLOWED_ORIGINS`):
- `https://howzy-web.web.app`
- `https://howzy-web.firebaseapp.com`
- Add your custom domain when configured

## Setup

```bash
npm install
npm run build
```

## Local Development

```bash
npm run serve   # Builds + starts Firebase emulators (functions, firestore, storage)
```

## Deploy

```bash
# First time: ensure you're logged in and project exists
firebase use howzy-api

# Deploy everything
npm run deploy                            # Functions only
firebase deploy --only firestore:rules    # Firestore rules only
firebase deploy --only storage            # Storage rules only
```

## Environment Variables (Firebase Functions Config)

Set via Firebase CLI:
```bash
firebase functions:secrets:set GOOGLE_CLIENT_ID
firebase functions:secrets:set GOOGLE_CLIENT_SECRET
firebase functions:secrets:set HOWZY_BOOTSTRAP_KEY
```

## Bootstrap Super Admin

After first deploy, create your super admin:
```bash
curl -X POST https://us-central1-howzy-api.cloudfunctions.net/bootstrapSuperAdmin \
  -H "x-bootstrap-key: <YOUR_SECRET_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"email": "admin@yourdomain.com"}'
```
Then sign in with Google and the custom claim `role: super_admin` will be applied.

