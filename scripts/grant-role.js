// Grants or revokes the administrator role for an existing account.
// Usage: npm run role -- grant admin user@example.com
//        npm run role -- revoke admin user@example.com
// Run this on the server; it is intentionally not available through the web API.
require('dotenv').config();

const { db } = require('../src/db');
const { audit } = require('../src/common');

const [action, role, email] = process.argv.slice(2);
if (!['grant', 'revoke'].includes(action) || role !== 'admin' || !email) {
  console.error('Usage: npm run role -- <grant|revoke> admin <email>');
  console.error('Doctor status is granted only through credential verification in the admin workspace.');
  process.exit(1);
}

const user = db.prepare('SELECT id, name FROM users WHERE email = ?').get(email.trim().toLowerCase());
if (!user) {
  console.error('No account uses that email address. Register the account in the app first.');
  process.exit(1);
}

const now = new Date().toISOString();
if (action === 'grant') {
  db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_id, granted_at) VALUES (?, ?, ?)').run(user.id, role, now);
    audit({ ip: 'cli' }, 'role.granted', 'user', user.id, { role });
  })();
  console.log(`Granted ${role} to ${user.name}. They will see the admin workspace after refreshing.`);
} else {
  db.transaction(() => {
    db.prepare('DELETE FROM user_roles WHERE user_id = ? AND role_id = ?').run(user.id, role);
    audit({ ip: 'cli' }, 'role.revoked', 'user', user.id, { role });
  })();
  console.log(`Revoked ${role} from ${user.name}.`);
}
db.close();
