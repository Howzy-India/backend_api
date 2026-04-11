# Howzy Platform — Architecture Map

## Stack Overview

| Layer | Technology | Purpose |
|---|---|---|
| Frontend | React 18 + Vite + TailwindCSS | SPA, role-based dashboards |
| Auth | Firebase Authentication | Phone OTP + Email/Password |
| API | Cloud Functions v2 (Node.js 22, Express) | REST API, business logic |
| Projects DB | Cloud SQL for PostgreSQL 18 (Firebase Data Connect) | Projects, configs, photos, amenities |
| Realtime / Other | Cloud Firestore | Users, leads, enquiries, chat, bookings, attendance |
| AI | Google Gemini 2.x Flash (via @google/genai) | Sales chat agent, voice TTS |
| Backup | Google Sheets API (ADC) | Project data backup for super admin |
| CDN/Hosting | Firebase Hosting | Frontend static assets |
| Secrets | Firebase Secret Manager | All credentials — never in code |

---

## Data Architecture

### When to use Cloud SQL vs Firestore

| Use Cloud SQL (PostgreSQL) | Use Firestore |
|---|---|
| Projects, configurations, photos, amenities | Users / roles |
| Complex queries (filter by zone + city + type) | Leads & enquiries |
| Full-text search (GIN index) | Chat sessions & messages |
| Reporting / aggregations | Attendance records |
| Structured relational data with FK integrity | Bookings |
| Data requiring migrations & schema versioning | Submissions / approvals |

### Cloud SQL Schema

```
projects (44 fields)
├── id UUID PK
├── unique_id TEXT UNIQUE           -- PROP-<uuid>
├── name TEXT
├── developer_name TEXT
├── rera_number TEXT
├── property_type ENUM              -- PROJECT | PLOT | FARMLAND
├── project_type ENUM               -- GATED_SOCIETY | SEMI_GATED | STAND_ALONE | VILLA_COMMUNITY | ULTRA_LUXURY
├── project_segment ENUM            -- PREMIUM | ECONOMY | SUPER_LUXURY
├── possession_status ENUM          -- RTMI | UNDER_CONSTRUCTION | EOI
├── possession_date TEXT
├── address TEXT
├── zone ENUM                       -- WEST | EAST | SOUTH | NORTH | CENTRAL
├── location TEXT                   -- cluster/micromarket
├── area TEXT                       -- suburb/locality
├── city TEXT (indexed)
├── state TEXT
├── pincode TEXT
├── landmark TEXT
├── map_link TEXT
├── land_parcel NUMERIC             -- acres
├── number_of_towers INT
├── total_units INT
├── available_units INT
├── density ENUM                    -- LOW_DENSITY | MEDIUM_DENSITY | HIGH_DENSITY
├── sft_costing_per_sqft NUMERIC
├── emi_starts_from TEXT
├── pricing_two_bhk NUMERIC
├── pricing_three_bhk NUMERIC
├── pricing_four_bhk NUMERIC
├── video_link_3d TEXT
├── brochure_link TEXT
├── onboarding_agreement_link TEXT
├── project_manager_name TEXT
├── project_manager_contact TEXT
├── spoc_name TEXT
├── spoc_contact TEXT
├── usp TEXT
├── teaser TEXT
├── details TEXT
├── status ENUM (indexed)           -- ACTIVE | INACTIVE | COMING_SOON | PENDING_APPROVAL
├── lead_registration_status TEXT
├── created_by TEXT                 -- Firebase UID
├── updated_by TEXT
├── created_at TIMESTAMPTZ (indexed DESC)
└── updated_at TIMESTAMPTZ

configurations (per project, 1-N)
├── id UUID PK
├── project_id UUID FK → projects.id (indexed)
├── bhk_count INT
├── min_sft NUMERIC
├── max_sft NUMERIC
└── unit_count INT

project_photos (per project, 1-N)
├── id UUID PK
├── project_id UUID FK → projects.id (indexed)
├── url TEXT
└── display_order INT

project_amenities (per project, M-N via unique constraint)
├── id UUID PK
├── project_id UUID FK → projects.id (indexed)
└── amenity TEXT

Indexes: idx_projects_city, idx_projects_zone, idx_projects_status,
         idx_projects_property_type, idx_projects_created_at (DESC),
         idx_projects_fts (GIN full-text on name+developer+location)
```

### Firestore Collections

```
users/{uid}                         -- profile, role, region
leads/{id}                          -- buyer leads
enquiries/{id}                      -- property enquiries
submissions/{id}                    -- partner/admin submissions (approval workflow)
bookings/{id}                       -- confirmed deals
chat_sessions/{id}                  -- AI chat sessions
chat_sessions/{id}/messages/{id}    -- individual messages
attendance/{id}                     -- punch-in/out records
builders/{id}                       -- builder profiles
```

---

## Request Flow

```
Browser (Firebase Auth)
    │  Firebase ID Token (JWT)
    ▼
Cloud Function (Express)
    │  src/middleware/auth.ts → verifies token via Firebase Admin SDK
    │  requireRole("admin","super_admin") → checks Firestore users/{uid}.role
    ▼
 ┌──────────────────────────────────────────┐
 │  Projects endpoints          │  All other │
 │  POST /admin/properties      │  endpoints │
 │  PATCH /admin/properties/:id │           │
 │  GET /projects               │           │
 │        ▼                     │     ▼     │
 │  src/lib/db.ts               │  Firestore │
 │  Cloud SQL (IAM auth)        │  (Admin SDK│
 │  PostgreSQL 18               │)          │
 │        ▼                     │           │
 │  src/lib/sheetsBackup.ts     │           │
 │  Google Sheets (ADC)         │           │
 └──────────────────────────────────────────┘
```

---

## Role Hierarchy & Permissions

| Role | Can Do |
|---|---|
| `super_admin` | Full CRUD on projects (direct), manage all users, view backup sheet, approve submissions |
| `admin` | Create project (→ PENDING_APPROVAL), manage leads, view all enquiries |
| `sales` | View leads, update enquiry status, view assigned properties |
| `partner` | Submit new properties for approval, view own enquiries |
| `client` | Browse projects, submit enquiries, view own data |

---

## API Endpoints Reference

### Projects (Cloud SQL)
| Method | Path | Role | Description |
|---|---|---|---|
| `GET` | `/projects` | Public | List with filters: city, zone, status, type, q (FTS), after (cursor) |
| `GET` | `/projects/:id` | Public | Full project + configs + photos + amenities |
| `POST` | `/admin/properties` | admin, super_admin | Create project (all 44 fields + nested) |
| `PATCH` | `/admin/properties/:id` | admin, super_admin | Partial update |
| `DELETE` | `/admin/properties/:id` | admin, super_admin | Soft delete (INACTIVE) |
| `GET` | `/admin/settings/backup-sheet` | super_admin | Returns Google Sheet URL |

### Leads / Enquiries / Users (Firestore)
| Method | Path | Role | Description |
|---|---|---|---|
| `GET` | `/leads` | admin+ | All leads |
| `POST` | `/leads` | any | Create lead |
| `PATCH` | `/leads/:id` | any | Update lead |
| `GET` | `/enquiries` | admin+ | All enquiries |
| `POST` | `/enquiries` | any | Create enquiry |
| `GET` | `/admin/users` | super_admin | All admin users |
| `POST` | `/admin/users` | super_admin | Create admin user |

### AI Chat
| Method | Path | Role | Description |
|---|---|---|---|
| `POST` | `/chat/sessions` | any | Create session |
| `POST` | `/chat/sessions/:id/message` | any | Send message → Gemini |
| `POST` | `/chat/tts` | any | Text-to-speech (Neural2) |

---

## Frontend Component Map

```
App.tsx
├── Login.tsx                       -- Firebase Auth (OTP + email)
├── Splash.tsx                      -- Loading/splash screen
└── [role-based dashboard]
    ├── SuperAdminDashboard.tsx     -- super_admin view
    │   ├── Projects tab → PropertyListSection
    │   │   └── CreateProjectModal.tsx  ← NEW (all 44 fields, multi-step)
    │   ├── Leads tab
    │   ├── Enquiries tab → AdminEnquiriesPanel.tsx
    │   ├── Users tab
    │   └── Settings tab (backup sheet URL)
    ├── PilotDashboard.tsx          -- admin/sales view
    │   └── Projects tab → PropertyListSection
    │       └── CreateProjectModal.tsx  ← NEW (shared)
    └── ClientPortal.tsx            -- client view
        └── Browse projects (read-only)
```

---

## Environment Variables

### Frontend (`.env.local`)
```
VITE_API_BASE_URL=https://api-<hash>-as.a.run.app
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=...
VITE_FIREBASE_PROJECT_ID=howzy-api
VITE_FIREBASE_STORAGE_BUCKET=...
VITE_FIREBASE_MESSAGING_SENDER_ID=...
VITE_FIREBASE_APP_ID=...
```

### Backend (Firebase Secrets — never in code)
```
CLOUD_SQL_INSTANCE = howzy-api:asia-south1:howzy-api-instance
DB_NAME            = howzy-api-database
DB_USER            = howzy-api@appspot
BACKUP_SHEET_ID    = 1OmbyiRthh9fqiJirOHRP9n6Op7diDuSWcbNqRTZcT8I
```

---

## Security Rules

### Firestore Rules (`firestore.rules`)
- Public read: `/projects` (Firestore shadow — not used for main projects)
- Authenticated write: leads, enquiries
- Role-checked write: submissions, admin collections

### Cloud SQL
- IAM auth only (`cloudsql.iam_authentication: on`)
- GRANT SELECT/INSERT/UPDATE/DELETE on all tables → `howzy-api@appspot`
- No public IP ingress from untrusted sources

---

## Deployment

| What | How | Trigger |
|---|---|---|
| Backend | `firebase deploy --only functions` | GitHub Actions on merge to `main` |
| Frontend | `firebase deploy --only hosting` | GitHub Actions on merge to `main` |
| DB Schema | `firebase dataconnect:sql:migrate` | Manual, PR-gated |
| Secrets | `firebase functions:secrets:set KEY` | Manual (one-time) |

> **Never deploy manually.** All changes go through PR → CI → merge.

---

## Git Workflow

### Branching Convention

All changes — including documentation, bug fixes, and features — **must follow this workflow** to avoid merge conflicts:

```
1. Sync main
   git checkout main && git pull origin main

2. Create a new branch from main
   git checkout -b <type>/<short-description>
   # Examples:
   #   feat/project-form-rera-fields
   #   fix/cloud-sql-type-filter
   #   docs/update-architecture

3. Make your changes and commit
   git add <files>
   git commit -m "<type>: <description>

   Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"

4. Push the branch
   git push origin <branch-name>

5. Raise a Pull Request → main
   - Title: "<type>: <short description>"
   - Ensure CI (TypeScript build + SonarCloud) passes before merging
   - Use squash merge to keep main history clean
```

### Branch Naming

| Prefix | When to use |
|---|---|
| `feat/` | New feature or UI addition |
| `fix/` | Bug fix or error correction |
| `docs/` | Documentation-only changes |
| `chore/` | Config, tooling, or dependency updates |
| `refactor/` | Code restructuring without behavior change |

### Rules

- **Never commit directly to `main`** — all changes via PR only
- **Always branch from latest `main`** — run `git pull origin main` before branching
- **One concern per PR** — keep PRs focused to reduce review friction and conflict surface
- **Merge strategy: squash** — keeps `main` history linear and readable
- CI must be green (TypeScript ✅ + SonarCloud ✅) before merge
