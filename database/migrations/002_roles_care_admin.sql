-- Roles, account status, doctor verification, consultations, attachments,
-- notifications, moderation, approved content, system settings, and audit logs.

ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended'));
ALTER TABLE users ADD COLUMN status_reason TEXT CHECK (status_reason IS NULL OR length(status_reason) <= 500);

CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY CHECK (id IN ('patient', 'doctor', 'admin')),
  description TEXT NOT NULL
);
INSERT OR IGNORE INTO roles (id, description) VALUES
  ('patient', 'Personal health space: AI chat, tracking, appointments, and consultations'),
  ('doctor', 'Professional workspace; restricted features require verification'),
  ('admin', 'Restricted administration: verification, accounts, reports, content, audit');

CREATE TABLE IF NOT EXISTS user_roles (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES roles(id),
  granted_at TEXT NOT NULL,
  granted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (user_id, role_id)
);
CREATE INDEX IF NOT EXISTS user_roles_role_idx ON user_roles(role_id);
INSERT OR IGNORE INTO user_roles (user_id, role_id, granted_at)
  SELECT id, 'patient', created_at FROM users;

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id TEXT REFERENCES chat_messages(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('chat', 'credential')),
  original_name TEXT NOT NULL CHECK (length(original_name) BETWEEN 1 AND 200),
  mime_type TEXT NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  sha256 TEXT NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS attachments_user_idx ON attachments(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS attachments_message_idx ON attachments(message_id);

ALTER TABLE chat_messages ADD COLUMN feedback TEXT CHECK (feedback IS NULL OR feedback IN ('helpful', 'not_helpful'));

CREATE TABLE IF NOT EXISTS doctor_profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  specialization TEXT NOT NULL DEFAULT '' CHECK (length(specialization) <= 120),
  qualifications TEXT NOT NULL DEFAULT '' CHECK (length(qualifications) <= 500),
  registration_number TEXT NOT NULL DEFAULT '' CHECK (length(registration_number) <= 80),
  registration_authority TEXT NOT NULL DEFAULT '' CHECK (length(registration_authority) <= 160),
  registration_country TEXT NOT NULL DEFAULT '' CHECK (length(registration_country) <= 80),
  years_experience INTEGER CHECK (years_experience IS NULL OR years_experience BETWEEN 0 AND 70),
  clinic_name TEXT NOT NULL DEFAULT '' CHECK (length(clinic_name) <= 160),
  clinic_address TEXT NOT NULL DEFAULT '' CHECK (length(clinic_address) <= 300),
  bio TEXT NOT NULL DEFAULT '' CHECK (length(bio) <= 1500),
  availability_note TEXT NOT NULL DEFAULT '' CHECK (length(availability_note) <= 300),
  accepting_consultations INTEGER NOT NULL DEFAULT 0 CHECK (accepting_consultations IN (0, 1)),
  verification_status TEXT NOT NULL DEFAULT 'pending_verification'
    CHECK (verification_status IN ('pending_verification', 'verified', 'rejected', 'revoked')),
  verified_at TEXT,
  verified_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS doctor_profiles_status_idx ON doctor_profiles(verification_status, specialization);

CREATE TABLE IF NOT EXISTS doctor_verifications (
  id TEXT PRIMARY KEY,
  doctor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  registration_number TEXT NOT NULL,
  registration_authority TEXT NOT NULL,
  registration_country TEXT NOT NULL,
  qualifications TEXT NOT NULL,
  specialization TEXT NOT NULL,
  credential_attachment_id TEXT REFERENCES attachments(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'approved', 'rejected', 'withdrawn')),
  reviewer_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  reviewer_notes TEXT NOT NULL DEFAULT '' CHECK (length(reviewer_notes) <= 1000),
  submitted_at TEXT NOT NULL,
  reviewed_at TEXT
);
CREATE INDEX IF NOT EXISTS doctor_verifications_status_idx ON doctor_verifications(status, submitted_at);
CREATE INDEX IF NOT EXISTS doctor_verifications_doctor_idx ON doctor_verifications(doctor_user_id, submitted_at DESC);

CREATE TABLE IF NOT EXISTS consultations (
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  doctor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000),
  preferred_time TEXT NOT NULL DEFAULT '' CHECK (length(preferred_time) <= 120),
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'accepted', 'declined', 'cancelled', 'completed')),
  scheduled_at TEXT,
  doctor_note TEXT NOT NULL DEFAULT '' CHECK (length(doctor_note) <= 1000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (patient_id <> doctor_id)
);
CREATE INDEX IF NOT EXISTS consultations_patient_idx ON consultations(patient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS consultations_doctor_idx ON consultations(doctor_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS shared_patient_records (
  id TEXT PRIMARY KEY,
  consultation_id TEXT NOT NULL REFERENCES consultations(id) ON DELETE CASCADE,
  patient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  doctor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  record_type TEXT NOT NULL CHECK (record_type IN ('conversation')),
  record_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE (consultation_id, record_type, record_id)
);
CREATE INDEX IF NOT EXISTS shared_records_doctor_idx ON shared_patient_records(doctor_id, consultation_id);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (length(type) BETWEEN 1 AND 60),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  body TEXT NOT NULL DEFAULT '' CHECK (length(body) <= 1000),
  screen TEXT,
  read_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  reporter_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('doctor', 'message')),
  target_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000),
  snapshot TEXT NOT NULL DEFAULT '' CHECK (length(snapshot) <= 12000),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewing', 'resolved', 'dismissed')),
  resolution_note TEXT NOT NULL DEFAULT '' CHECK (length(resolution_note) <= 1000),
  resolved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reports_status_idx ON reports(status, created_at DESC);

CREATE TABLE IF NOT EXISTS health_content (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL CHECK (category IN ('relaxation', 'education')),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  summary TEXT NOT NULL DEFAULT '' CHECK (length(summary) <= 300),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 8000),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT
);
CREATE INDEX IF NOT EXISTS health_content_status_idx ON health_content(status, category, published_at DESC);

CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY CHECK (key IN ('registration_open', 'doctor_registration_open', 'announcement')),
  value TEXT NOT NULL CHECK (length(value) <= 500),
  updated_at TEXT NOT NULL,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL
);
INSERT OR IGNORE INTO system_settings (key, value, updated_at) VALUES
  ('registration_open', 'true', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('doctor_registration_open', 'true', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('announcement', '', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 80),
  target_type TEXT,
  target_id TEXT,
  details TEXT NOT NULL DEFAULT '{}',
  ip_address TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_logs_created_idx ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_actor_idx ON audit_logs(actor_user_id, created_at DESC);
