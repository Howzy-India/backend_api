# Projects Extended Fields — Implementation Plan

## Overview
Migrate the `projects` collection from Firestore to **Firebase Data Connect (Cloud SQL for PostgreSQL)**,
add 25+ new fields from the CSV spec, wire Google Sheets backup, and expose a super-admin backup link endpoint.

---

## Affected Files

| Action | File |
|--------|------|
| CREATE | `dataconnect/dataconnect.yaml` |
| CREATE | `dataconnect/schema/schema.gql` |
| CREATE | `dataconnect/connector/connector.yaml` |
| CREATE | `dataconnect/connector/queries.gql` |
| CREATE | `dataconnect/connector/mutations.gql` |
| CREATE | `src/lib/db.ts` |
| CREATE | `src/lib/sheetsBackup.ts` |
| CREATE | `src/types/project.ts` |
| MODIFY | `src/lib/mappers.ts` |
| MODIFY | `src/api/index.ts` |
| MODIFY | `firebase.json` |
| MODIFY | `package.json` |

---

## Step 1 — Firebase Data Connect Schema

**File:** `dataconnect/dataconnect.yaml`
Configure the Data Connect service pointing to a Cloud SQL instance.

**File:** `dataconnect/schema/schema.gql`
Define all tables:
- `Project` — 44 columns (all existing + 25 new from CSV)
- `Configuration` — BHK configs per project (FK → projects, CASCADE)
- `ProjectPhoto` — Photo URLs per project (FK → projects, CASCADE)
- `ProjectAmenity` — Amenity tags per project (FK → projects, CASCADE, UNIQUE per project+amenity)

**File:** `dataconnect/connector/connector.yaml`
Define the connector with auth level and SDK generation config.

**File:** `dataconnect/connector/queries.gql`
- `ListProjects` — filtered list with keyset pagination + FTS
- `GetProject` — full detail with nested configs/photos/amenities
- `ListProjectsAdmin` — admin list with all fields

**File:** `dataconnect/connector/mutations.gql`
- `CreateProject` — insert project row (server-side only)
- `UpdateProject` — update project row (server-side only)
- `DeleteProject` — soft delete via status change

---

## Step 2 — TypeScript Types

**File:** `src/types/project.ts`
- `ProjectRow` interface — matches SQL columns (snake_case)
- `ProjectResponse` interface — API response shape (camelCase)
- `ConfigurationRow`, `ProjectPhotoRow`, `ProjectAmenityRow`
- `CreateProjectInput`, `UpdateProjectInput` — validated request bodies
- Enums: `PropertyType`, `ProjectSegment`, `ProjectType`, `PossessionStatus`, `DensityType`, `ProjectZone`, `ProjectStatus`, `BhkType`

---

## Step 3 — Cloud SQL Database Connection

**File:** `src/lib/db.ts`
- Uses `@google-cloud/cloud-sql-connector` for IAM-based auth (Unix socket in Cloud Functions)
- Creates a `pg.Pool` with connection limit 10
- Exports `pool` singleton + `withTransaction(fn)` helper
- Reads secrets: `CLOUD_SQL_INSTANCE`, `DB_NAME`, `DB_USER`, `DB_PASS`

---

## Step 4 — SQL Mapper

**File:** `src/lib/mappers.ts` (add `mapProjectRow`)
- `mapProjectRow(row)` — converts snake_case SQL row to camelCase API response
- Includes nested `configurations`, `photos`, `amenities` arrays
- Keeps existing `mapProjectDoc` (Firestore) for backward compatibility during transition

---

## Step 5 — Google Sheets Backup Service

**File:** `src/lib/sheetsBackup.ts`
- Authenticates with service account JSON from secret `GOOGLE_SHEETS_SA_JSON`
- `upsertProjectRow(project: ProjectResponse): Promise<void>`
  - Reads col A to find existing row by `uniqueId`
  - If found: `values.update` that row range
  - If not found: `values.append` a new row
- 39 columns in CSV order (see mapping in plan.md)
- Fire-and-forget: errors logged to console.error, never throws

---

## Step 6 — API Endpoint Updates

**File:** `src/api/index.ts`

### 6a. `GET /projects` (public)
Replace `collections.projects.get()` with:
```sql
SELECT p.*, array_agg(DISTINCT jsonb_build_object(...) ) AS configurations,
       array_agg(DISTINCT ph.url ORDER BY ph.display_order) AS photos,
       array_agg(DISTINCT pa.amenity) AS amenities
FROM projects p
LEFT JOIN configurations c ON c.project_id = p.id
LEFT JOIN project_photos ph ON ph.project_id = p.id
LEFT JOIN project_amenities pa ON pa.project_id = p.id
WHERE p.status != 'INACTIVE'
  AND ($city::text IS NULL OR p.city ILIKE $city)
  AND ($type::text IS NULL OR p.property_type = $type)
  AND ($q::text   IS NULL OR to_tsvector('english', p.name || ' ' || p.developer_name || ' ' || COALESCE(p.location,''))
                              @@ plainto_tsquery('english', $q))
GROUP BY p.id
ORDER BY p.created_at DESC
LIMIT 50
```
Keyset pagination via `?after=<uuid>`.

### 6b. `GET /projects/:id` (public)
Replace Firestore doc fetch with `SELECT ... WHERE p.id = $1 OR p.unique_id = $1`.

### 6c. `POST /admin/properties` (admin/super_admin)
- Accept all 39 new fields
- Wrap in `withTransaction`: INSERT projects → INSERT configurations[] → INSERT photos[] → INSERT amenities[]
- For `admin` role: set `status = 'PENDING_APPROVAL'`; for `super_admin`: set `status = 'ACTIVE'`
- After commit: call `sheetsBackup.upsertProjectRow(result)` (fire-and-forget)

### 6d. `PATCH /admin/properties/:id` — **NEW endpoint**
- Accept partial body (any fields)
- Wrap in `withTransaction`: UPDATE projects → DELETE+INSERT configurations → DELETE+INSERT amenities → append photos
- After commit: call `sheetsBackup.upsertProjectRow(result)` (fire-and-forget)

### 6e. `GET /admin/settings/backup-sheet` — **NEW endpoint**
- `requireRole('super_admin')`
- Returns `{ sheetUrl: "https://docs.google.com/spreadsheets/d/<BACKUP_SHEET_ID>/edit" }`

---

## Step 7 — Firebase Config Updates

**File:** `firebase.json`
Add `dataconnect` key:
```json
{
  "dataconnect": {
    "source": "dataconnect"
  }
}
```

**File:** `package.json`
Add dependencies:
- `@google-cloud/cloud-sql-connector`
- `pg`
- `googleapis` (for Sheets API)

Add devDependency:
- `@types/pg`

---

## Step 8 — Firebase Secrets to Configure (manual, not in code)
```
firebase functions:secrets:set CLOUD_SQL_INSTANCE   # e.g. howzy-api:asia-south1:howzy-db
firebase functions:secrets:set DB_NAME              # howzy
firebase functions:secrets:set DB_USER              # howzy_api
firebase functions:secrets:set DB_PASS              # <password>
firebase functions:secrets:set GOOGLE_SHEETS_SA_JSON  # full service account JSON
firebase functions:secrets:set BACKUP_SHEET_ID      # Google Sheet ID
```

---

## Validation Checklist
- [ ] `npm run build` passes (TypeScript no errors)
- [ ] `GET /projects` returns projects with all new fields
- [ ] `GET /projects/:id` returns full project detail with nested arrays
- [ ] `POST /admin/properties` (super_admin) → inserts to SQL + creates Sheet row
- [ ] `POST /admin/properties` (admin) → inserts as PENDING_APPROVAL
- [ ] `PATCH /admin/properties/:id` → updates SQL + updates Sheet row
- [ ] `GET /admin/settings/backup-sheet` → returns sheet URL (super_admin only)
- [ ] `GET /admin/settings/backup-sheet` → 403 for non-super_admin

---

## SQL Indexes (auto-applied via Data Connect migration)
```sql
CREATE INDEX idx_projects_city_status   ON projects (city, status);
CREATE INDEX idx_projects_type_segment  ON projects (property_type, project_segment);
CREATE INDEX idx_projects_zone_city     ON projects (zone, city);
CREATE INDEX idx_projects_created_at    ON projects (created_at DESC);
CREATE INDEX idx_projects_fts ON projects USING GIN (
  to_tsvector('english', name || ' ' || developer_name || ' ' || COALESCE(location,''))
);
CREATE INDEX idx_config_project_id ON configurations (project_id);
CREATE INDEX idx_photos_project_id  ON project_photos (project_id, display_order);
CREATE UNIQUE INDEX idx_amenities_uq ON project_amenities (project_id, amenity);
```
