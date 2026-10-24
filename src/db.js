const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const databasePath = process.env.NODE_ENV === 'test' && process.env.HEALIX_DATABASE_PATH
  ? path.resolve(process.env.HEALIX_DATABASE_PATH)
  : path.join(__dirname, '..', 'database', 'HEALIX.db');
const migrationsPath = path.join(__dirname, '..', 'database', 'migrations');
// Attachment bytes live on disk outside the public folder; the database stores metadata and storage keys only.
const uploadsPath = process.env.NODE_ENV === 'test' && process.env.HEALIX_UPLOAD_PATH
  ? path.resolve(process.env.HEALIX_UPLOAD_PATH)
  : path.join(__dirname, '..', 'database', 'uploads');
fs.mkdirSync(path.dirname(databasePath), { recursive: true });
fs.mkdirSync(uploadsPath, { recursive: true });

const db = new Database(databasePath);
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )
`);
const appliedMigrations = new Set(
  db.prepare('SELECT name FROM schema_migrations').all().map((row) => row.name)
);
for (const name of fs.readdirSync(migrationsPath).filter((file) => file.endsWith('.sql')).sort()) {
  if (appliedMigrations.has(name)) continue;
  const migration = fs.readFileSync(path.join(migrationsPath, name), 'utf8');
  db.transaction(() => {
    db.exec(migration);
    db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(name, new Date().toISOString());
  })();
}

module.exports = { db, databasePath, uploadsPath };
