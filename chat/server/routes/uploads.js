/**
 * File upload routes.
 *
 * POST /api/upload        — multipart upload, writes to <workspace>/context/,
 *                           runs the parser, returns metadata + preview.
 * GET  /api/uploads/:name — serves a file from context/ for thumbnail rendering.
 *
 * Files in context/ are gitignored and persist across sessions. The chat
 * session layer keeps the per-turn pendingUploads list; the files themselves
 * live on disk until the user deletes them.
 */

import path from 'node:path';
import { existsSync, mkdirSync, statSync, realpathSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import multer from 'multer';
import { WORKSPACE_DIR } from '../core/paths.js';
import { isSensitiveWorkspacePath } from '../core/sensitive-paths.js';
import { parseFile } from '../parsers/index.js';

export const CONTEXT_DIR = path.join(WORKSPACE_DIR, 'context');
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB per file

// ── Security: reject sensitive files even if the browser serves them up.
// Pattern list mirrors scripts/pre-commit-security-check.sh. Regex is simpler
// than globbing: we match against the lowercased basename.
const BLOCKED_NAME_PATTERNS = [
  /^\.env(\..+)?$/,                   // .env, .env.local, .env.production
  /\.pem$/,
  /\.key$/,
  /\.p12$/,
  /\.pfx$/,
  /\.jks$/,
  /\.keystore$/,
  /\.(cert|crt|cer)$/,
  /\.secret$/,
  /^credentials(\.[a-z0-9]+)?$/,      // credentials, credentials.json, credentials.yaml
  /^service-account.*\.json$/,
  /^id_rsa($|\.pub$)/,
  /^id_ed25519($|\.pub$)/,
  /\.(db|sqlite|sqlite3)$/,
];

/**
 * Strip any path components off a filename and return the raw basename.
 * Used for the blocklist check (which must see the ORIGINAL name, including
 * leading dots — otherwise `.env` would slip through once the dot is stripped).
 */
function rawBasename(raw) {
  if (!raw) return null;
  const base = path.basename(String(raw));
  if (!base || base === '.' || base === '..') return null;
  return base;
}

/**
 * Sanitise a filename to something safe to write under context/.
 * - Strip path components (basename only).
 * - Replace any non-[A-Za-z0-9._-] with underscore.
 * - Strip leading dots so we never write a hidden file.
 * - Reject empty / dot-only / oversized names.
 */
function sanitiseFilename(raw) {
  const base = rawBasename(raw);
  if (!base) return null;
  const safe = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  if (!safe || safe === '_' || safe.length > 200) return null;
  return safe;
}

/**
 * Reject filenames that match known-sensitive patterns. Case-insensitive.
 * Returns a human-readable reason string on block, or null if the name is ok.
 */
function checkBlocked(name) {
  const lower = name.toLowerCase();
  for (const pattern of BLOCKED_NAME_PATTERNS) {
    if (pattern.test(lower)) {
      return `File type not allowed — "${name}" matches a blocked pattern (credentials/keys/databases).`;
    }
  }
  return null;
}

/** Ensure we never write outside context/ — path traversal defence. */
function isInsideContextDir(absPath) {
  const rel = path.relative(CONTEXT_DIR, absPath);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Pick a non-clobbering filename under context/ for a sanitised name. */
function resolveTargetPath(sanitised) {
  const target = path.join(CONTEXT_DIR, sanitised);
  if (!existsSync(target)) return { absPath: target, filename: sanitised };
  // File exists — prefix a timestamp to deduplicate.
  const ts = Date.now();
  const prefixed = `${ts}-${sanitised}`;
  return { absPath: path.join(CONTEXT_DIR, prefixed), filename: prefixed };
}

// Multer configured with memoryStorage so we can inspect and validate the
// buffer before touching disk. Limits enforced server-side (UI limit is advisory).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE, files: 10 },
});

export function mountUploadRoutes(app) {
  // Guarantee the target directory exists. The template ships it with a
  // .gitkeep, but a clean checkout could still delete it.
  if (!existsSync(CONTEXT_DIR)) {
    mkdirSync(CONTEXT_DIR, { recursive: true });
  }

  // ── Upload endpoint ─────────────────────────────────────────────────────
  app.post('/api/upload', (req, res) => {
    upload.single('file')(req, res, async (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({ error: `File too large — max is ${MAX_FILE_SIZE / (1024 * 1024)} MB.` });
        }
        return res.status(400).json({ error: err.message || 'Upload failed.' });
      }

      const file = req.file;
      if (!file) return res.status(400).json({ error: 'No file provided.' });

      // Run blocklist on the ORIGINAL basename — sanitisation strips leading
      // dots, which would otherwise let `.env` through as plain `env`.
      const rawName = rawBasename(file.originalname);
      if (!rawName) {
        return res.status(400).json({ error: 'Filename could not be sanitised to a safe value.' });
      }
      const blockedReason = checkBlocked(rawName);
      if (blockedReason) {
        return res.status(403).json({ error: blockedReason });
      }

      const sanitised = sanitiseFilename(file.originalname);
      if (!sanitised) {
        return res.status(400).json({ error: 'Filename could not be sanitised to a safe value.' });
      }

      const { absPath, filename } = resolveTargetPath(sanitised);
      if (!isInsideContextDir(absPath)) {
        return res.status(400).json({ error: 'Resolved path is outside context/.' });
      }

      try {
        await writeFile(absPath, file.buffer);
      } catch (e) {
        return res.status(500).json({ error: `Could not save file: ${e.message}` });
      }

      // Parsing is best-effort — we never fail the upload if the parser throws.
      let parsed = null;
      try {
        parsed = await parseFile(absPath);
      } catch { /* parser crash already logged by the registry */ }

      const relativePath = path.posix.join('context', filename);
      res.json({
        filename,
        relativePath,
        size: file.size,
        mime: parsed?.mime || file.mimetype || 'application/octet-stream',
        parsed,
      });
    });
  });

  // ── Workspace file view ────────────────────────────────────────────────
  // Serves any file under WORKSPACE_DIR as text/plain so the chat can link
  // file paths mentioned in assistant messages (docs/README.md, backend/app.py…).
  // Defensive path validation + the same blocklist as uploads — never serve
  // .env, credentials, keys, etc., even if the AI references them.
  app.get('/api/workspace-file', (req, res) => {
    const rel = typeof req.query.path === 'string' ? req.query.path : '';
    if (!rel || rel.length > 400) return res.status(400).send('Bad path');

    // Normalise and reject absolute paths or traversal
    const normalised = path.posix.normalize(rel.replace(/\\/g, '/'));
    if (normalised.startsWith('/') || normalised.startsWith('..') || normalised.includes('\0')) {
      return res.status(400).send('Bad path');
    }

    // Never serve credential/secret paths that live INSIDE the workspace —
    // notably .chat/secrets.json (the live MGA key) and workspace .env files.
    // The basename blocklist below is not enough: it misses secrets.json and
    // is directory-blind, so this segment-aware check runs first.
    if (isSensitiveWorkspacePath(normalised)) {
      return res.status(403).send('File type not allowed');
    }

    const absPath = path.join(WORKSPACE_DIR, normalised);
    const workspaceReal = path.resolve(WORKSPACE_DIR);
    if (!path.resolve(absPath).startsWith(workspaceReal + path.sep) && path.resolve(absPath) !== workspaceReal) {
      return res.status(400).send('Bad path');
    }

    if (!existsSync(absPath)) return res.status(404).send('Not found');

    // Symlink-aware containment: the textual check above passes for a symlink
    // that lives inside the workspace but points OUT of it, and sendFile()
    // follows symlinks. Resolve the real path and re-check before serving.
    let realPath;
    try {
      realPath = realpathSync(absPath);
      const realRoot = realpathSync(WORKSPACE_DIR);
      if (realPath !== realRoot && !realPath.startsWith(realRoot + path.sep)) {
        return res.status(400).send('Bad path');
      }
    } catch {
      return res.status(404).send('Not found');
    }

    // Re-run the strong secret predicate on the RESOLVED real target — a symlink
    // named innocuously (notes.txt) could point at .chat/secrets.json, which the
    // requested-path check above wouldn't catch.
    if (isSensitiveWorkspacePath(path.relative(WORKSPACE_DIR, realPath))) {
      return res.status(403).send('File type not allowed');
    }

    // Blocklist (basename only — matches upload rules), on the REAL target.
    const basename = path.basename(realPath);
    if (checkBlocked(basename)) return res.status(403).send('File type not allowed');
    try {
      const st = statSync(absPath);
      if (!st.isFile()) return res.status(404).send('Not found');
      if (st.size > 5 * 1024 * 1024) return res.status(413).send('File too large to preview');
    } catch {
      return res.status(404).send('Not found');
    }

    // Serve as text/plain so the browser doesn't execute HTML/JS/etc.
    // Markdown and source files render readably; images still open correctly
    // because browsers sniff the first few bytes — but we also set charset=utf-8.
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `inline; filename="${basename.replace(/"/g, '')}"`);
    res.sendFile(absPath);
  });

  // ── File-serving endpoint ──────────────────────────────────────────────
  // Used by the frontend to render inline image thumbnails and "open file" links.
  // Only serves files that actually live inside context/; rejects traversal.
  app.get('/api/uploads/:name', (req, res) => {
    const rawName = rawBasename(req.params.name);
    if (!rawName) return res.status(400).json({ error: 'Bad filename' });

    const blockedReason = checkBlocked(rawName);
    if (blockedReason) return res.status(403).json({ error: String(blockedReason) });

    const sanitised = sanitiseFilename(req.params.name);
    if (!sanitised) return res.status(400).json({ error: 'Bad filename' });

    const absPath = path.join(CONTEXT_DIR, sanitised);
    if (!isInsideContextDir(absPath) || !existsSync(absPath)) {
      return res.status(404).json({ error: 'Not found' });
    }

    try {
      const st = statSync(absPath);
      if (!st.isFile()) return res.status(404).json({ error: 'Not found' });
    } catch {
      return res.status(404).json({ error: 'Not found' });
    }

    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(absPath);
  });
}
