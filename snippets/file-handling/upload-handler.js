/**
 * SNIPPET: File Upload Handler
 * CATEGORY: File Handling
 * LANGUAGE: JavaScript (Express)
 * STATUS: ✅ Ready
 * 
 * DESCRIPTION: 
 *   Handle file uploads with validation, size limits, and type checking.
 *   ⚠️ IMPORTANT: Uses MEMORY storage - files are NOT saved to disk!
 *   This is intentional - containers are ephemeral.
 * 
 * DEPENDENCIES: 
 *   npm install multer
 * 
 * USAGE:
 *   const upload = require('./upload-handler');
 *   // NOTE: Route is '/upload', NOT '/api/upload'
 *   // Frontend calls fetch('/api/upload') → Backend receives '/upload'
 *   app.post('/upload', upload.single('file'), (req, res) => {
 *     // File is in req.file.buffer (memory, not disk!)
 *     const content = req.file.buffer.toString('utf-8');
 *     res.json({ size: req.file.size });
 *   });
 * 
 * EXAMPLE:
 *   // Single file - Frontend: fetch('/api/import') → Backend: '/import'
 *   app.post('/import', upload.single('document'), (req, res) => {
 *     const data = parseCSV(req.file.buffer);
 *     res.json({ rows: data.length });
 *   });
 *   
 *   // Multiple files - Frontend: fetch('/api/import-many') → Backend: '/import-many'
 *   app.post('/import-many', upload.array('files', 5), (req, res) => {
 *     req.files.forEach(file => console.log(file.buffer));
 *   });
 */

const multer = require('multer');
const path = require('path');

const MAX_SIZE = process.env.UPLOAD_MAX_SIZE || 10 * 1024 * 1024; // 10MB default

/**
 * Sanitize a filename to prevent path traversal and injection.
 * Strips directory components, null bytes, and non-printable characters.
 * @param {string} filename - Original filename from upload
 * @returns {string} Safe filename
 */
function sanitizeFilename(filename) {
  if (!filename) return 'unnamed';
  // Strip path components (prevents ../../../etc/passwd)
  let safe = path.basename(filename);
  // Remove null bytes
  safe = safe.replace(/\0/g, '');
  // Remove non-printable characters and control characters
  safe = safe.replace(/[^\x20-\x7E]/g, '');
  // Remove characters problematic on filesystems
  safe = safe.replace(/[<>:"/\\|?*]/g, '_');
  // Collapse multiple dots/underscores
  safe = safe.replace(/\.{2,}/g, '.').replace(/_{2,}/g, '_');
  // Don't allow leading dots (hidden files)
  safe = safe.replace(/^\.+/, '');
  return safe || 'unnamed';
}

// Allowed file types (customize as needed)
const ALLOWED_TYPES = [
  'text/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/pdf',
  'application/json',
  'text/plain',
  'image/jpeg',
  'image/png',
  'image/gif'
];

// File filter function
const fileFilter = (req, file, cb) => {
  if (ALLOWED_TYPES.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error(`File type ${file.mimetype} not allowed`), false);
  }
};

// ⚠️ MEMORY STORAGE - Files stay in RAM, not saved to disk!
// This is intentional - containers are ephemeral
const upload = multer({
  storage: multer.memoryStorage(),  // ✅ Memory, not disk!
  limits: {
    fileSize: MAX_SIZE,
    files: 5  // Max 5 files at once
  },
  fileFilter: fileFilter
});

module.exports = upload;

/**
 * Helper: Get file extension from mimetype
 */
function getExtension(mimetype) {
  const map = {
    'text/csv': '.csv',
    'application/vnd.ms-excel': '.xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
    'application/pdf': '.pdf',
    'application/json': '.json',
    'text/plain': '.txt',
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif'
  };
  return map[mimetype] || '';
}

module.exports.getExtension = getExtension;
module.exports.sanitizeFilename = sanitizeFilename;

/**
 * Send a file as a download response with security headers.
 * Forces the browser to download rather than render inline (prevents XSS from uploaded files).
 * @param {import('express').Response} res
 * @param {Buffer} buffer - File content
 * @param {string} filename - Download filename (will be sanitized)
 * @param {string} contentType - MIME type
 */
function sendFileDownload(res, buffer, filename, contentType) {
  const safeName = sanitizeFilename(filename);
  res.set({
    'Content-Type': contentType,
    'Content-Disposition': `attachment; filename="${safeName}"`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  });
  res.send(buffer);
}

module.exports.sendFileDownload = sendFileDownload;
