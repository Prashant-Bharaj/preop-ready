/**
 * scopes: [backend]
 * flags: [file-uploads]
 * description: Multer upload handler (TypeScript) with memory storage and size limits.
 */

/**
 * File Upload Handler (TypeScript)
 *
 * Handle file uploads with validation, size limits, and type checking.
 * IMPORTANT: Uses MEMORY storage — files are NOT saved to disk.
 * Containers are ephemeral; persist meaningful files to your DB or object store.
 *
 * Dependencies:
 *   npm install multer
 *   npm install -D @types/multer
 *
 * Usage:
 *   import upload, { sanitizeFilename, getExtension, sendFileDownload } from './upload-handler.js';
 *   // NOTE: Route is '/upload', NOT '/api/upload' (Traefik/nginx strips /api).
 *   app.post('/upload', upload.single('file'), (req, res) => {
 *     const content = req.file?.buffer.toString('utf-8');
 *     res.json({ size: req.file?.size });
 *   });
 */

import multer, { type Multer } from 'multer';
import * as path from 'path';
import type { Request, Response } from 'express';

const MAX_SIZE: number =
  Number(process.env.UPLOAD_MAX_SIZE) || 10 * 1024 * 1024; // 10MB default

/**
 * Sanitize a filename to prevent path traversal and injection.
 * Strips directory components, null bytes, and non-printable characters.
 */
export function sanitizeFilename(filename: string | undefined): string {
  if (!filename) return 'unnamed';
  let safe = path.basename(filename);
  safe = safe.replace(/\0/g, '');
  // eslint-disable-next-line no-control-regex
  safe = safe.replace(/[^\x20-\x7E]/g, '');
  safe = safe.replace(/[<>:"/\\|?*]/g, '_');
  safe = safe.replace(/\.{2,}/g, '.').replace(/_{2,}/g, '_');
  safe = safe.replace(/^\.+/, '');
  return safe || 'unnamed';
}

// Allowed file types (customize as needed)
const ALLOWED_TYPES: readonly string[] = [
  'text/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/pdf',
  'application/json',
  'text/plain',
  'image/jpeg',
  'image/png',
  'image/gif',
];

const fileFilter: multer.Options['fileFilter'] = (_req, file, cb) => {
  if (ALLOWED_TYPES.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error(`File type ${file.mimetype} not allowed`));
  }
};

// MEMORY STORAGE — containers are ephemeral.
const upload: Multer = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_SIZE,
    files: 5,
  },
  fileFilter,
});

export default upload;

/**
 * Map a mimetype to a conventional file extension.
 */
export function getExtension(mimetype: string): string {
  const map: Record<string, string> = {
    'text/csv': '.csv',
    'application/vnd.ms-excel': '.xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
    'application/pdf': '.pdf',
    'application/json': '.json',
    'text/plain': '.txt',
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
  };
  return map[mimetype] || '';
}

/**
 * Send a file as a download response with security headers.
 * Forces the browser to download rather than render inline.
 */
export function sendFileDownload(
  res: Response,
  buffer: Buffer,
  filename: string,
  contentType: string
): void {
  const safeName = sanitizeFilename(filename);
  res.set({
    'Content-Type': contentType,
    'Content-Disposition': `attachment; filename="${safeName}"`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  });
  res.send(buffer);
}
