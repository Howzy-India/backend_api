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
resale_properties/{id}              -- client resale submissions (Pending → Listed/Rejected)
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

### Resale Properties (Firestore)
| Method | Path | Role | Description |
|---|---|---|---|
| `GET` | `/resale` | Public | List all Listed resale properties |
| `GET` | `/resale/mine` | client+ | List own resale submissions |
| `POST` | `/resale` | authenticated | Submit resale property (status = Pending) |
| `PATCH` | `/resale/:id` | owner (Pending only) | Update own pending resale |
| `PATCH` | `/resale/:id/delegate` | owner (Pending only) | Assign agent to own pending resale |
| `GET` | `/admin/resale` | admin, super_admin | All resale properties with filters |
| `POST` | `/admin/resale` | admin, super_admin | Add resale directly (status = Listed) |
| `PATCH` | `/admin/resale/:id/status` | admin, super_admin | Approve (Listed) or Reject |
| `DELETE` | `/admin/resale/:id` | admin, super_admin | Delete resale property |

#### Resale Firestore Document Schema
```
resale_properties/{id}
├── id                   string  -- auto-generated
├── title                string  REQUIRED
├── description          string
├── price                string
├── propertyType         string  -- Apartment | Villa | Plot | Farmland …
├── segment              string  -- Premium | Economy | Super Luxury
├── societyType          string
├── city                 string  REQUIRED
├── location             string
├── area                 string
├── address              string
├── zone                 string  -- West | East | South | North | Central
├── cluster              string  -- dropdown: Neopolis | Kokapet | Gachibowli | Miyapur | Bachupally | LB Nagar | Kothapet | Uppal
├── state                string
├── pincode              string
├── landmark             string
├── mapLink              string
├── bedrooms             number
├── bathrooms            number
├── floor                number
├── totalFloors          number
├── possession           string
├── emiFrom              string
├── floorPlan            string  -- Firebase Storage URL (image or PDF)
├── ownerName            string
├── ownerPhone           string
├── agentName            string
├── agentPhone           string
├── status               string  -- Pending | Listed | Rejected
├── remarks              string
├── submittedBy          string  (email)
├── submittedByUid       string
├── submittedByRole      string
├── approvedBy           string
├── approvedAt           timestamp
├── created_at           timestamp
└── updated_at           timestamp
```

#### Floor Plan Upload Flow
```
Client selects file (image/PDF)
    │  Firebase Storage SDK (frontend)
    ▼
Firebase Storage: resale/floor-plans/{timestamp}_{filename}
    │  getDownloadURL()
    ▼
URL stored in resaleForm.floorPlan (string)
    │  Submitted as part of POST /resale or PATCH /resale/:id payload
    ▼
Firestore resale_properties/{id}.floorPlan = <download URL>
```

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
    │   │   └── CreateProjectModal.tsx  (all 44 fields, single-page sectioned)
    │   ├── Resale Properties tab → ResalePropertiesAdmin
    │   │   ├── Add Resale form (inline, file upload for floor plan)
    │   │   ├── Status filter (Pending / Listed / Rejected)
    │   │   └── Approve / Reject / Delete actions
    │   ├── Verification List tab → Projects Onboard submissions
    │   ├── Leads tab
    │   ├── Enquiries tab → AdminEnquiriesPanel.tsx
    │   ├── Users tab
    │   └── Settings tab (backup sheet URL)
    ├── PilotDashboard.tsx          -- admin/sales view
    │   └── Projects tab → PropertyListSection
    │       └── CreateProjectModal.tsx  (shared)
    ├── HowzerSourcingDashboard.tsx -- howzer_sourcing employee view
    │   ├── Projects Onboard card (count of submissions)
    │   └── Onboard Project form → CreateProjectModal (→ Pending Approval)
    └── ClientPortal.tsx            -- client view
        ├── Browse projects (public, read-only)
        ├── My Dashboard
        │   └── My Listings tab
        │       ├── Add Resale button → Resale modal form
        │       │   ├── All CSV fields incl. Floor Plan upload (Firebase Storage)
        │       │   ├── Edit (Pending only)
        │       │   └── Delegate to agent (Pending only)
        │       └── Resale table (status badge, Edit/Delegate/View actions)
        └── Browse Resale (Listed only, public)
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
DB_USER            = 923565373621-compute@developer
BACKUP_SHEET_ID    = 1OmbyiRthh9fqiJirOHRP9n6Op7diDuSWcbNqRTZcT8I
```

---

## Security Rules

### Firebase Storage Rules (`storage.rules`)

| Path pattern | Read | Write |
|---|---|---|
| `attendance/{email}/{date}/{file}` | owner or admin/super_admin | owner (agent/partner/admin/super_admin) |
| `properties/{propertyId}/{file}` | public | admin / super_admin / partner |
| `projects/**` | public | admin / super_admin / howzer_sourcing / howzer_sales |
| `resale/floor-plans/{file}` | public | any authenticated user |
| `submissions/{submissionId}/{file}` | admin / super_admin / partner | partner / admin / super_admin |

> **Rule deployed via CI only** — never `firebase deploy` manually.

### Firestore Rules (`firestore.rules`)
- Public read: `/projects` (Firestore shadow — not used for main projects)
- Authenticated write: leads, enquiries
- Role-checked write: submissions, admin collections

### Cloud SQL
- IAM auth only (`cloudsql.iam_authentication: on`)
- GRANT SELECT/INSERT/UPDATE/DELETE on all tables → `923565373621-compute@developer`
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

---

## Autonomous Feature Development Workflow

Every new feature or bug fix **must follow this end-to-end flow** before being considered done:

```
Branch → Implement → Build → E2E Test (Playwright) → PR → Sonar Green → Merge
```

### Step-by-Step

```
1. Branch from main
   git checkout -b feat/<feature-name>

2. Implement the feature
   - Backend: src/api/index.ts + lib/ + migrations
   - Frontend: src/components/ + src/pages/ + src/api/

3. Build (must pass with zero errors)
   cd backend-api  && npm run build
   cd frontend-web && npm run build

4. Write or update Playwright E2E tests
   File: frontend-web/e2e/<NN>-<feature>.spec.ts
   Auth: use programmatic IndexedDB injection (see helpers.ts signIn())
   Run:  npx playwright test e2e/<NN>-<feature>.spec.ts --reporter=list

5. All tests must pass (zero failures, zero flaky)
   ✅ TC-xx-01: Happy path
   ✅ TC-xx-02: Validation / edge cases
   ✅ TC-xx-03: API consistency check

6. Commit and push
   git add <files>
   git commit -m "<type>: <description>\n\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
   git push -u origin <branch>

7. Raise PR → main (both backend and frontend if changed)
   - Backend repo: Howzy-India/backend_api
   - Frontend repo: Howzy-India/frontend-web

8. SonarCloud must show 0 new issues before merge

9. Squash merge → main

10. Deploy (auto-triggered by CI on main merge)
    - Backend: Firebase Functions (us-central1)
    - Frontend: Firebase Hosting (howzy-web.web.app)
```

### E2E Auth Pattern (phone-OTP apps)

The app uses phone OTP login only — no email/password UI. To authenticate in tests:

```typescript
// In e2e/helpers.ts — signIn()
// 1. POST to Firebase REST API with email+password → get idToken + refreshToken
// 2. Build authUser object with stsTokenManager
// 3. page.evaluate() → write to IndexedDB firebaseLocalStorageDb
// 4. page.reload() → Firebase SDK picks up the injected session
```

Credentials are stored in `frontend-web/.env.test.local` (not committed):
```
E2E_SUPER_ADMIN_EMAIL=super_admin@howzy.in
E2E_SUPER_ADMIN_PASSWORD=...
E2E_FIREBASE_API_KEY=...
```

### Test File Naming Convention

| File | Feature |
|---|---|
| `e2e/01-auth.spec.ts` | Login / OTP flow |
| `e2e/13-create-project.spec.ts` | Create Project modal |
| `e2e/<NN>-<feature>.spec.ts` | New features follow sequential numbering |

### Key Playwright Selectors (reference)

| Element | Selector |
|---|---|
| Add Project button | `button >> text="+ Add New Project"` |
| Project name input | `input[placeholder="e.g. Prestige Lakeside Habitat"]` |
| Validation error badge | `span.bg-red-500` |
| Zone select | `nth=4` select (0-indexed) → value `'WEST'` |
| Cluster select | `nth=5` select → value e.g. `'Gachibowli'` |
| Submit button | `button[type="submit"]` with text `Add Project` |
