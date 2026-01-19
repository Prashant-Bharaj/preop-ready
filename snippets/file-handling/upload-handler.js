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
 *   app.post('/api/upload', upload.single('file'), (req, res) => {
 *     // File is in req.file.buffer (memory, not disk!)
 *     const content = req.file.buffer.toString('utf-8');
 *     res.json({ size: req.file.size });
 *   });
 * 
 * EXAMPLE:
 *   // Single file - access via req.file.buffer
 *   app.post('/api/import', upload.single('document'), (req, res) => {
 *     const data = parseCSV(req.file.buffer);
 *     res.json({ rows: data.length });
 *   });
 *   
 *   // Multiple files - access via req.files[].buffer
 *   app.post('/api/import-many', upload.array('files', 5), (req, res) => {
 *     req.files.forEach(file => console.log(file.buffer));
 *   });
 */

const multer = require('multer');

const MAX_SIZE = process.env.UPLOAD_MAX_SIZE || 10 * 1024 * 1024; // 10MB default

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
