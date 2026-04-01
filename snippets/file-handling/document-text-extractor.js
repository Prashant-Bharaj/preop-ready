/**
 * SNIPPET: Document Text Extractor
 * CATEGORY: File Handling
 * LANGUAGE: JavaScript (Node.js)
 * STATUS: Ready
 *
 * DESCRIPTION:
 *   Extracts text content from uploaded documents for AI analysis.
 *   Supports PDF, DOCX, DOC, XLSX/XLS, PPTX, CSV, JSON, XML, TXT, and Markdown.
 *   Works with multer for file uploads — process in memory or from disk.
 *
 * DEPENDENCIES:
 *   npm install multer pdf-parse mammoth exceljs adm-zip
 *
 * USAGE:
 *   const { extractText, uploadAndExtract } = require('./document-text-extractor');
 *
 *   // Extract from a file path
 *   const text = await extractText('/path/to/file.pdf', 'application/pdf', 'report.pdf');
 *
 *   // Use as Express middleware (upload + extract in one step)
 *   app.post('/analyze', uploadAndExtract.single('file'), (req, res) => {
 *     res.json({ text: req.extractedText, filename: req.file.originalname });
 *   });
 *
 *   // Multi-file upload + extract
 *   app.post('/analyze-many', uploadAndExtract.array('files', 10), (req, res) => {
 *     res.json({ documents: req.extractedTexts });
 *   });
 *
 * EXAMPLE EXPRESS ROUTE:
 *   app.post('/extract', uploadAndExtract.single('file'), async (req, res) => {
 *     if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
 *
 *     // Send extracted text to LLM for analysis
 *     const { callLLM } = require('./llm-client');
 *     const summary = await callLLM(req.extractedText, {
 *       systemPrompt: 'Summarize this document in 3 bullet points.',
 *     });
 *     res.json({ summary, filename: req.file.originalname });
 *   });
 *
 * RELATED:
 *   - snippets/llm/bayer-llm-client.js (send extracted text to LLM)
 *   - snippets/llm/mga-assistant-client.js (send extracted text to MGA)
 *   - snippets/file-handling/upload-handler.js (general file uploads)
 */

const fs = require('fs');
const path = require('path');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const ExcelJS = require('exceljs');
const AdmZip = require('adm-zip');

// ---------------------------------------------------------------------------
// Upload directory setup
// ---------------------------------------------------------------------------
const UPLOADS_DIR =
  process.env.NODE_ENV === 'production'
    ? '/data/uploads'
    : path.join(__dirname, '..', 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// Core: Extract text from any supported file
// ---------------------------------------------------------------------------

/**
 * Extract text content from a file.
 *
 * @param {string} filePath - Path to the file on disk
 * @param {string} mimetype - MIME type (e.g. 'application/pdf')
 * @param {string} originalname - Original filename (used for extension detection)
 * @returns {Promise<string>} - Extracted text content
 */
async function extractText(filePath, mimetype, originalname) {
  const ext = (originalname || '').toLowerCase().split('.').pop();

  // PDF
  if (mimetype === 'application/pdf' || ext === 'pdf') {
    const buffer = fs.readFileSync(filePath);
    const data = await pdfParse(buffer);
    return data.text;
  }

  // DOCX (modern Word)
  if (
    mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    ext === 'docx'
  ) {
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value;
  }

  // DOC (legacy Word) — best-effort plain text
  if (mimetype === 'application/msword' || ext === 'doc') {
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch {
      return '[Could not extract text from .doc file]';
    }
  }

  // Excel (XLSX, XLS) — converts each sheet to CSV
  if (
    mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    mimetype === 'application/vnd.ms-excel' ||
    ext === 'xlsx' || ext === 'xls'
  ) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const sheets = [];
    workbook.eachSheet((sheet) => {
      const rows = [];
      sheet.eachRow((row) => {
        rows.push(row.values.slice(1).join(','));
      });
      sheets.push(`[Sheet: ${sheet.name}]\n${rows.join('\n')}`);
    });
    return sheets.join('\n\n');
  }

  // PowerPoint (PPTX) — extracts text from slide XML
  if (
    mimetype === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
    ext === 'pptx'
  ) {
    try {
      const zip = new AdmZip(filePath);
      const entries = zip.getEntries();
      const texts = [];
      for (const entry of entries) {
        if (entry.entryName.startsWith('ppt/slides/slide') && entry.entryName.endsWith('.xml')) {
          const xml = entry.getData().toString('utf-8');
          const stripped = xml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
          if (stripped) texts.push(stripped);
        }
      }
      return texts.join('\n\n') || '[No text content found in PPTX]';
    } catch {
      return '[Could not extract text from PPTX file]';
    }
  }

  // Text-based files (CSV, JSON, XML, TXT, Markdown, etc.)
  if (
    mimetype.startsWith('text/') ||
    mimetype === 'application/json' ||
    mimetype === 'application/xml' ||
    mimetype === 'application/csv' ||
    ['csv', 'json', 'xml', 'txt', 'md', 'yaml', 'yml', 'toml'].includes(ext)
  ) {
    return fs.readFileSync(filePath, 'utf-8');
  }

  // Fallback: try reading as text
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return '[Binary file — content could not be extracted]';
  }
}

// ---------------------------------------------------------------------------
// Supported file types (for frontend validation)
// ---------------------------------------------------------------------------

const SUPPORTED_TYPES = {
  'application/pdf': 'PDF',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'DOCX',
  'application/msword': 'DOC',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'XLSX',
  'application/vnd.ms-excel': 'XLS',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PPTX',
  'text/plain': 'TXT',
  'text/csv': 'CSV',
  'text/markdown': 'Markdown',
  'application/json': 'JSON',
  'application/xml': 'XML',
};

const SUPPORTED_EXTENSIONS = '.pdf,.docx,.doc,.xlsx,.xls,.pptx,.csv,.json,.xml,.txt,.md,.yaml,.yml';

// ---------------------------------------------------------------------------
// Multer middleware with auto text extraction
// ---------------------------------------------------------------------------

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max
});

/**
 * Wraps multer to auto-extract text after upload and clean up temp files.
 * Adds `req.extractedText` (single) or `req.extractedTexts` (array) to the request.
 */
const uploadAndExtract = {
  single: (fieldName) => [
    upload.single(fieldName),
    async (req, res, next) => {
      if (!req.file) return next();
      try {
        req.extractedText = await extractText(req.file.path, req.file.mimetype, req.file.originalname);
        next();
      } catch (err) {
        next(err);
      } finally {
        try { fs.unlinkSync(req.file.path); } catch {}
      }
    },
  ],

  array: (fieldName, maxCount) => [
    upload.array(fieldName, maxCount),
    async (req, res, next) => {
      if (!req.files || req.files.length === 0) return next();
      try {
        req.extractedTexts = await Promise.all(
          req.files.map(async (f) => ({
            name: f.originalname,
            size: f.size,
            type: f.mimetype,
            text: await extractText(f.path, f.mimetype, f.originalname),
          }))
        );
        next();
      } catch (err) {
        next(err);
      } finally {
        for (const f of req.files) {
          try { fs.unlinkSync(f.path); } catch {}
        }
      }
    },
  ],
};

module.exports = {
  extractText,
  uploadAndExtract,
  SUPPORTED_TYPES,
  SUPPORTED_EXTENSIONS,
};
