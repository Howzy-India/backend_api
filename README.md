# Howzy Backend API

Firebase Cloud Functions backend for the Howzy real estate platform. Serves as the single backend for both `frontend_ui` and `client_portal` apps.

## Architecture

- **Callable Functions** — Role-gated operations invoked via Firebase SDK
  - User management (`createUserWithRole`, `updateUserRole`, `setUserDisabled`, `deleteUser`)
  - Builder approval workflow (`submitBuilderForApproval`, `approveBuilder`, `rejectBuilder`, `deleteBuilderIfUnapproved`)
  - Bootstrap (`bootstrapSuperAdmin`)

- **HTTP API** (`api`) — Express app exposed as a single Cloud Function
  - `/health` — Health check
  - `/projects` — Projects + approved submissions
  - `/leads` — Lead CRUD + auto-assign
  - `/earnings` — Bookings & earnings
  - `/submissions` — Submission CRUD + status updates
  - `/enquiries` — Enquiry CRUD + status + timeline
  - `/admin/*` — Sales team, partners, assign, client logins, client 360
  - `/client/*` — Client enquiries, login tracking
  - `/pilot/*` — Sales-assigned enquiries
  - `/partner/*` — Partner-assigned enquiries
  - `/auth/google/*` — Google Calendar OAuth
  - `/calendar/*` — Calendar events CRUD

## Firestore Collections

`projects`, `leads`, `bookings`, `submissions`, `enquiries`, `enquiry_timeline`, `client_logins`, `users`, `builders`, `approvals`, `auditLogs`

## Setup

```bash
npm install
npm run build
```

## Local Development

```bash
npm run serve   # Builds + starts Firebase emulators
```

## Deploy

```bash
npm run deploy  # Builds + deploys Cloud Functions
```

## Environment Variables

| Variable | Description |
|---|---|
| `GOOGLE_CLIENT_ID` | Google OAuth client ID (Calendar) |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |

## Firebase Secrets

| Secret | Description |
|---|---|
| `HOWZY_BOOTSTRAP_KEY` | Key for the bootstrap super admin endpoint |
