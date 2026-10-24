# HEALIX AI

HEALIX AI is a responsive web application for general health education, private personal tracking, and connecting patients with administrator-verified doctors. It uses a small single-server architecture:

- **Frontend:** accessible HTML, CSS, and browser JavaScript served by Express (`public/app.js` core and patient features, `public/care.js` doctor directory, consultations and doctor workspace, `public/admin.js` administration).
- **Backend:** Node.js 20+ and Express. Authentication, authorization, private records, files, and AI calls stay on the server (`src/server.js`, `src/auth.js`, `src/ai.js`, `src/routes/*`).
- **Database:** SQLite through `better-sqlite3`, stored at `database/HEALIX.db`. Schema changes are versioned under `database/migrations/` and applied automatically, in order, on startup.

This is a self-hosted V1, not a hosted medical-record platform or a replacement for a clinician. A single SQLite file and in-memory rate limits suit a local or small single-instance deployment. Use a reviewed server database and a dedicated deployment, security, and regulatory review before storing records for a larger population.

## Requirements and first run

Install Node.js 20 or newer, then from the project root:

```powershell
npm install
Copy-Item .env.example .env   # only if you do not already have a .env
npm run db:init               # optional; the server also initializes the database on startup
npm start
```

Open `http://localhost:3000`. `npm run dev` starts the same server with Node's watch mode. Do not commit `.env` or put provider keys in frontend code. Keep a backup of any existing local secrets before editing environment configuration.

### Creating the first administrator

Administrator access cannot be self-registered or granted through the web API. Register a normal account in the app, then on the server run:

```powershell
npm run role -- grant admin you@example.com
npm run role -- revoke admin you@example.com
```

Both actions are written to the audit log. Doctor status is never granted this way; it comes only from credential verification in the admin workspace.

## Roles and permissions

All permissions are enforced by the backend on every request. Roles and account status are re-read from the database each time, so suspensions and verification changes take effect immediately.

| Role | How it is obtained | Can do |
| --- | --- | --- |
| Patient | Every account | AI chat with attachments, history, hydration, appointments, relaxation, directory, consultation requests, sharing a conversation with an accepted consultation, notifications, profile, export, deletion |
| Doctor | Choosing "Doctor" at registration | Edit a professional profile and submit credentials. The account starts as `pending_verification` |
| Verified doctor | An administrator approves the credentials | Listed in the directory, receives consultation requests, accepts, declines or completes them, reads conversations a patient explicitly shares (each read is audited) |
| Administrator | `npm run role` on the server | Verify or reject doctors (after checking the registration with the issuing authority), revoke verification, suspend or reinstate accounts, handle reports, publish health content, view audit logs and app health, change registration settings |

Choosing "Doctor" or uploading a certificate never verifies anyone. Changing registration details after verification returns the profile to `pending_verification`. Administrators cannot read users' conversations, hydration, or appointments. Reports of AI replies include only the reported reply text.

## AI configuration

`src/ai.js` is the only module that talks to the provider. The default is **Google Gemini** through its native `generateContent` API, with the key sent in the `x-goog-api-key` header. An OpenAI-compatible Chat Completions provider is also built in (`AI_PROVIDER=openai-compatible`). More providers can be added to the `providers` map without changing routes or UI.

To enable Gemini, create a key at https://aistudio.google.com/apikey and set it in `.env`:

```
AI_PROVIDER=gemini
AI_API_KEY=your-gemini-key
AI_MODEL=gemini-3.5-flash
```

Restart the server after changing `.env`.

| Variable | Required | Purpose |
| --- | --- | --- |
| `AI_API_KEY` | For AI replies | Provider API key, read only by the server (`GEMINI_API_KEY` is also accepted) |
| `AI_PROVIDER` | No | `gemini` (default) or `openai-compatible` |
| `AI_MODEL` | No | Defaults to `gemini-3.5-flash` (Gemini) or `gpt-4o-mini` (OpenAI-compatible) |
| `AI_FALLBACK_MODELS` | No | Comma-separated models tried in order when the main model is busy, rate-limited, unavailable, or too slow. Defaults to `gemini-3.5-flash-lite,gemini-3.6-flash` for Gemini |
| `AI_ATTEMPT_TIMEOUT_MS` | No | Longest a single model attempt may take before moving to the next model; defaults to 25000 |
| `AI_BASE_URL` | No | API root; defaults to `https://generativelanguage.googleapis.com/v1beta` or `https://api.openai.com/v1` |
| `AI_TIMEOUT_MS` | No | Total time a user waits for a reply across all attempts; defaults to 60000 |
| `AI_IMAGE_INPUT` | No | Send images to the model. Defaults to `true` for Gemini and `false` for OpenAI-compatible |
| `AI_PDF_INPUT` | No | Send PDFs to the model. Same defaults as images |

Gemini models are sometimes overloaded (HTTP 503 "high demand"). HEALIX then retries on the fallback models within the time budget, so a reply usually still arrives. A bad API key or a safety block is not retried.

If Gemini blocks a prompt or reply for safety reasons, the user sees a "declined to answer" message and no assistant reply is stored. An invalid key or model name, or an exhausted quota, produces a clear error that is logged on the server (the log never contains message content).

Without `AI_API_KEY`, the app shows a setup notice and chat requests return HTTP 503. No reply is synthesized or saved. Messages are sent only after the user confirms the sharing notice. A failed provider call keeps the user's question and can be retried. The server sends a safety system prompt covering uncertainty, follow-up questions, emergencies, medicine questions (no prescribing, no invented doses or interactions), image limits, and no specialist-scan interpretation. This does not make the provider medically reliable or replace clinical review.

**Image and document understanding** works only when `AI_IMAGE_INPUT` / `AI_PDF_INPUT` are enabled *and* the configured model actually supports those inputs. When disabled, the UI disables the corresponding attach buttons and the server rejects such messages with a clear explanation. HEALIX does not extract PDF text itself; PDFs are passed to the provider only when `AI_PDF_INPUT=true`.

## Attachments

Users can attach JPEG, PNG, or WebP images and PDF documents (up to 4 per message, `ATTACHMENT_MAX_BYTES` each, `ATTACHMENT_QUOTA_BYTES` per user). The camera button uses the device camera where the browser supports `capture`. Types are verified from the file's content, not its name or declared type. Files are stored outside the web root at `database/uploads/<user>/<id>` (excluded from Git). The database stores only metadata, a SHA-256 hash, and the storage key. Files are served only to their owner (credential documents also to administrators reviewing them, with each view audited). They are deleted with their conversation or account. Only the newest message's files are sent to the provider; earlier files are referenced by name.

## Database

The database is `database/HEALIX.db`. Migrations:

- `001_initial.sql`: `users`, `user_profiles`, `user_settings`, `sessions`, `conversations`, `chat_messages`, `hydration_records`, `appointments`
- `002_roles_care_admin.sql`: `roles`, `user_roles`, account `status`, `attachments`, message `feedback`, `doctor_profiles`, `doctor_verifications`, `consultations`, `shared_patient_records`, `notifications`, `reports`, `health_content`, `system_settings`, `audit_logs`

`schema_migrations` records applied files. Existing databases upgrade in place: existing users receive the `patient` role and keep all their data. Foreign keys cascade account deletion to owned data. All queries are parameterized. Passwords are salted scrypt hashes. Session cookies are HttpOnly, SameSite=Strict, and contain opaque tokens whose hashes are stored. Never seed real-looking health records: new accounts start empty.

The database file, WAL files, uploads, dependencies, and environment files are excluded by `.gitignore`. Backups contain sensitive data and must be protected.

## Security notes

- Per-request authentication, role checks, and ownership checks on every record query.
- Rate limits for sign-in and registration, chat, uploads, and reports. Origin checks on state-changing API calls. Strict CSP and security headers.
- Audit log entries for registrations, sign-ins (including failures), password changes, verification decisions, credential views, account status changes, record sharing and viewing, content and settings changes, role grants, and account deletion. Audit details never contain health content.
- Self-service password change (signs out other devices), sign-out of other sessions, JSON export, and permanent deletion.
- For production: terminate TLS, set `NODE_ENV=production` (Secure cookies and HSTS), set `TRUST_PROXY=true` only behind a trusted proxy, protect the server filesystem, and configure provider data retention to meet applicable privacy requirements.

## Features

- Welcome, registration (personal or doctor), sign-in, persistent session, sign-out, and an admin-controlled announcement banner.
- Dashboard with hydration totals, upcoming appointments, and a breathing pause.
- AI chat: conversations, history, deletion, loading, error and retry states, formatted replies, copy, read-aloud, helpful or not-helpful feedback, reporting, image and PDF attachments (when the provider supports them), voice dictation where the browser supports it, and an Enter-to-send shortcut.
- Doctor directory (verified doctors only), consultation requests, doctor acceptance with date, time, and note, and patient-controlled sharing and revocation of AI conversations.
- Hydration logging with an optional personal goal (a preference, not a medical recommendation), appointment creation, editing, and deletion.
- Relaxation exercises (paced breathing, grounding, muscle release) and an administrator-published wellbeing library.
- In-app notifications for consultation and verification events.
- Profile, preferences, password, sessions, privacy notice, data export, and account deletion.

Not included in V1: email verification and password recovery, push or email notifications, video calls, payments, real-time chat with doctors, doctor calendars or slot booking, and diagnosis of X-rays or other medical scans. Browser voice support varies by browser and platform.

## Development and tests

```powershell
npm test
```

The Node test suite uses temporary SQLite databases and upload folders, so no production data is needed. It covers account isolation, validation, export and deletion, role enforcement, doctor verification, consultation sharing and revocation, suspension, content publishing, password changes, origin checks, AI configuration errors, the provider request format and safety prompt, retries, and attachment validation, privacy, and cleanup. AI tests use a local stand-in HTTP server that speaks both the Gemini and OpenAI-compatible protocols, so the real integration code runs without network access or credentials.
