# HEALIX AI

HEALIX AI is a responsive web application for general health education, private personal tracking, and appointment organization. This repository was empty when the app was added, so V1 uses a small single-server architecture rather than assuming an existing framework:

- **Frontend:** accessible HTML, CSS, and browser JavaScript served by Express.
- **Backend:** Node.js 20+ and Express; authentication, private records, and AI calls stay on the server.
- **Database:** SQLite through `better-sqlite3`, stored locally at `database/HEALIX.db`. Schema changes are versioned under `database/migrations/`.

This is a self-hosted V1, not a hosted medical-record platform or a replacement for a clinician. A single SQLite file is appropriate for a local/small single-instance deployment; use a reviewed server database and a dedicated deployment/security review before scaling to multiple app instances or storing records for a larger population.

## Requirements and first run

Install Node.js 20 or newer, then from the project root:

```powershell
npm install
```

Create `.env` from `.env.example` if you do not already have a local environment file. Do not commit `.env` or put provider keys in frontend code:

```powershell
Copy-Item .env.example .env
```

Set the AI provider values in the server environment (see [AI configuration](#ai-configuration)), then start the app:

```powershell
npm start
```

Open `http://localhost:3000`. `npm run dev` starts the same server with Node's watch mode. The SQLite database and schema are initialized automatically on first startup. The runtime database is created at `database/HEALIX.db`; the versioned migration source is `database/migrations/001_initial.sql`. Do not seed real-looking health records: new accounts start with empty tracking data.

The existing `.env` in this workspace is intentionally not included or documented here. `.env` is ignored by Git. Keep a backup of any local secrets before editing environment configuration.

## AI configuration

HEALIX calls an OpenAI-compatible Chat Completions endpoint from the backend only:

| Variable | Required | Purpose |
| --- | --- | --- |
| `AI_API_KEY` | For AI replies | Provider API key, read only by the server |
| `AI_BASE_URL` | No | API root; defaults to `https://api.openai.com/v1` |
| `AI_MODEL` | No | Model name; defaults to `gpt-4o-mini` |
| `PORT` | No | HTTP port; defaults to `3000` |
| `NODE_ENV` | No | Set to `production` for production cookie/security settings |
| `SESSION_COOKIE_SECURE` | No | Force Secure cookies with `true`; production mode enables it automatically |

Without `AI_API_KEY`, the app displays a setup notice and chat requests return an explicit configuration error. It does not synthesize or save a fake assistant reply. Chat messages are sent to the configured provider only after the user confirms the sharing notice in the assistant screen. Avoid including names, contact information, or other identifying details in health questions. The backend includes a brief safety prompt; it does not make the provider medically reliable or replace clinical review.

For a production deployment, terminate TLS, set `NODE_ENV=production`, protect the server and database filesystem, and configure provider access and retention according to the applicable privacy requirements. Do not expose this development server directly to the public internet without a security and compliance review.

## Data and privacy

Each account's records are scoped by its authenticated user ID. Passwords are stored as salted scrypt hashes; session cookies are HttpOnly, SameSite=Strict, and contain opaque tokens whose hashes are stored in SQLite. Logout and account deletion invalidate sessions. The profile screen provides a JSON data export and permanent self-service account/data deletion. The app avoids collecting diagnoses or other medical profile fields.

Database tables: `users`, `user_profiles`, `user_settings`, `sessions`, `conversations`, `chat_messages`, `hydration_records`, `appointments`, and `schema_migrations`. Foreign keys cascade account deletion to owned data. User inputs are validated and database operations use parameterized statements.

The database file, SQLite WAL files, dependencies, and environment files are excluded by `.gitignore`. Keep migration SQL under version control. Backups may contain sensitive user data and must be protected accordingly.

## Features

- Welcome, registration, sign-in, persistent session, and logout.
- Dashboard with empty states, personal hydration totals, upcoming appointments, and a one-minute breathing pause.
- AI chat with conversation creation/history/deletion, loading/error/retry states, context from recent messages, and a server-side configurable provider.
- Voice dictation where browser speech recognition is supported, with permission/error feedback and text-entry fallback; optional browser text-to-speech for replies.
- Hydration entry creation/removal and an optional user-set goal; the goal is a tracking preference, not a medical recommendation.
- Appointment creation, editing, and deletion.
- Profile name and preference updates, privacy/healthcare notice, data export, and account deletion.

Email/password recovery, email verification, push notifications, clinical records, and provider-linked care are not included. Browser voice capabilities vary by browser and platform.

## Development and tests

```powershell
npm test
```

The Node test suite uses a temporary SQLite database and checks account isolation, validation, export, and deletion. No production data is required to run it.
