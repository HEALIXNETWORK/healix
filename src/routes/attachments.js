const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { db, uploadsPath } = require('../db');
const { sendError, rateLimiter } = require('../common');
const { requireUser } = require('../auth');

const MAX_BYTES = Number(process.env.ATTACHMENT_MAX_BYTES) || 8 * 1024 * 1024;
const USER_QUOTA_BYTES = Number(process.env.ATTACHMENT_QUOTA_BYTES) || 200 * 1024 * 1024;
const router = express.Router();

// Identify the file from its leading bytes rather than trusting the declared type or extension.
function sniffMimeType(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buffer.length >= 5 && buffer.toString('ascii', 0, 5) === '%PDF-') return 'application/pdf';
  return null;
}

function safeFileName(header) {
  let name = '';
  try {
    name = decodeURIComponent(typeof header === 'string' ? header : '');
  } catch {
    name = '';
  }
  name = name.replace(/[\\/]/g, '_').replace(/[\u0000-\u001f\u007f"]/g, '').trim().slice(0, 200);
  return name || 'attachment';
}

function storagePath(storageKey) {
  const resolved = path.resolve(uploadsPath, storageKey);
  if (!resolved.startsWith(path.resolve(uploadsPath) + path.sep)) throw new Error('Invalid storage key.');
  return resolved;
}

function readAttachment(row) {
  return fs.readFileSync(storagePath(row.storage_key));
}

function removeStoredFiles(storageKeys) {
  for (const key of storageKeys) {
    try {
      fs.rmSync(storagePath(key), { force: true });
    } catch (error) {
      console.error('Could not remove an attachment file:', error.code || error.message);
    }
  }
}

function removeUserFiles(userId) {
  fs.rmSync(storagePath(userId), { recursive: true, force: true });
}

function publicAttachment(row) {
  return {
    id: row.id,
    name: row.original_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    purpose: row.purpose,
    createdAt: row.created_at
  };
}

function sendAttachmentContent(res, row) {
  const disposition = row.mime_type.startsWith('image/') ? 'inline' : 'attachment';
  res.setHeader('Content-Type', row.mime_type);
  res.setHeader('Content-Disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(row.original_name)}`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  return res.send(readAttachment(row));
}

const limitUploads = rateLimiter({
  max: 30,
  windowMs: 10 * 60 * 1000,
  key: (req) => req.user.id,
  message: 'Too many uploads. Please wait a few minutes and try again.'
});

router.post('/', requireUser, limitUploads, express.raw({ type: () => true, limit: MAX_BYTES }), (req, res) => {
  const purpose = req.query.purpose || 'chat';
  if (!['chat', 'credential'].includes(purpose)) return sendError(res, 400, 'Choose a valid attachment purpose.');
  if (purpose === 'credential' && !req.user.roles.includes('doctor')) {
    return sendError(res, 403, 'Only doctor accounts can upload credential documents.');
  }
  if (!Buffer.isBuffer(req.body) || !req.body.length) return sendError(res, 400, 'Choose a file to upload.');

  const declared = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const mimeType = sniffMimeType(req.body);
  if (!mimeType || mimeType !== declared) {
    return sendError(res, 415, 'Only JPEG, PNG, or WebP images and PDF documents are supported.');
  }
  const used = db.prepare('SELECT COALESCE(SUM(size_bytes), 0) AS total FROM attachments WHERE user_id = ?').get(req.user.id).total;
  if (used + req.body.length > USER_QUOTA_BYTES) {
    return sendError(res, 413, 'Your attachment storage is full. Delete older conversations to free space.');
  }

  const id = crypto.randomUUID();
  const storageKey = `${req.user.id}/${id}`;
  const file = storagePath(storageKey);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, req.body, { flag: 'wx', mode: 0o600 });
  const row = {
    id,
    user_id: req.user.id,
    purpose,
    original_name: safeFileName(req.headers['x-file-name']),
    mime_type: mimeType,
    size_bytes: req.body.length,
    sha256: crypto.createHash('sha256').update(req.body).digest('hex'),
    storage_key: storageKey,
    created_at: new Date().toISOString()
  };
  try {
    db.prepare(`
      INSERT INTO attachments (id, user_id, purpose, original_name, mime_type, size_bytes, sha256, storage_key, created_at)
      VALUES (@id, @user_id, @purpose, @original_name, @mime_type, @size_bytes, @sha256, @storage_key, @created_at)
    `).run(row);
  } catch (error) {
    removeStoredFiles([storageKey]);
    throw error;
  }
  return res.status(201).json({ attachment: publicAttachment(row) });
});

router.get('/:id/content', requireUser, (req, res) => {
  const row = db.prepare('SELECT * FROM attachments WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!row) return sendError(res, 404, 'Attachment not found.');
  return sendAttachmentContent(res, row);
});

// Only unsent chat attachments can be removed directly; sent ones are removed with their conversation.
router.delete('/:id', requireUser, (req, res) => {
  const row = db.prepare(`
    SELECT id, storage_key FROM attachments
    WHERE id = ? AND user_id = ? AND purpose = 'chat' AND message_id IS NULL
  `).get(req.params.id, req.user.id);
  if (!row) return sendError(res, 404, 'Attachment not found.');
  db.prepare('DELETE FROM attachments WHERE id = ?').run(row.id);
  removeStoredFiles([row.storage_key]);
  return res.json({ ok: true });
});

module.exports = {
  router,
  MAX_BYTES,
  readAttachment,
  removeStoredFiles,
  removeUserFiles,
  publicAttachment,
  sendAttachmentContent
};
