/**
 * scopes: [backend]
 * flags: [file-uploads, ai-rag]
 * description: Extract text (TypeScript) from uploaded PDF/DOCX/XLSX documents.
 */

/**
 * Document Text Extractor (TypeScript)
 *
 * Extracts text content from uploaded documents for AI analysis.
 * Supports PDF, DOCX, DOC, XLSX/XLS, PPTX, CSV, JSON, XML, TXT, and Markdown.
 *
 * Dependencies:
 *   npm install multer pdf-parse mammoth exceljs adm-zip
 *   npm install -D @types/multer @types/adm-zip
 *
 * Usage:
 *   import { extractText, uploadAndExtract } from './document-text-extractor.js';
 *
 *   const text = await extractText('/path/to/file.pdf', 'application/pdf', 'report.pdf');
 *
 *   app.post('/analyze', uploadAndExtract.single('file'), (req, res) => {
 *     res.json({ text: req.extractedText, filename: req.file?.originalname });
 *   });
 */

import * as fs from 'fs';
import * as path from 'path';
import multer, { type Multer } from 'multer';
import type { Request, Response, NextFunction, RequestHandler } from 'express';

// pdf-parse / mammoth / exceljs / adm-zip have spotty type coverage — declare loosely.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pdfParse = require('pdf-parse') as (buffer: Buffer) => Promise<{ text: string }>;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mammoth = require('mammoth') as {
  extractRawText: (input: { path: string }) => Promise<{ value: string }>;
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ExcelJS = require('exceljs') as {
  Workbook: new () => {
    xlsx: { readFile: (p: string) => Promise<void> };
    eachSheet: (
      cb: (sheet: {
        name: string;
        eachRow: (rowCb: (row: { values: unknown[] }) => void) => void;
      }) => void
    ) => void;
  };
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const AdmZip = require('adm-zip') as new (file: string) => {
  getEntries: () => Array<{ entryName: string; getData: () => Buffer }>;
};

// Extend Express Request to carry extracted-text payload added by the middleware.
declare module 'express-serve-static-core' {
  interface Request {
    extractedText?: string;
    extractedTexts?: ExtractedFile[];
  }
}

export interface ExtractedFile {
  name: string;
  size: number;
  type: string;
  text: string;
}

// ---------------------------------------------------------------------------
// Upload directory setup
// ---------------------------------------------------------------------------
const UPLOADS_DIR: string =
  process.env.NODE_ENV === 'production'
    ? '/data/uploads'
    : path.join(__dirname, '..', 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const UPLOADS_ROOT = path.resolve(UPLOADS_DIR);

/**
 * Pin a path to the uploads directory. multer writes there, but the value
 * still travels through request objects, so every read/unlink re-checks it
 * instead of trusting the caller.
 */
function resolveUploadPath(filePath: string): string {
  const abs = path.resolve(filePath);
  if (abs !== UPLOADS_ROOT && !abs.startsWith(UPLOADS_ROOT + path.sep)) {
    throw new Error('Refusing to access a file outside the uploads directory');
  }
  return abs;
}

// ---------------------------------------------------------------------------
// Core: Extract text from any supported file
// ---------------------------------------------------------------------------

export async function extractText(
  filePath: string,
  mimetype: string,
  originalname: string
): Promise<string> {
  const ext = (originalname || '').toLowerCase().split('.').pop() || '';
  const safePath = resolveUploadPath(filePath);

  // PDF
  if (mimetype === 'application/pdf' || ext === 'pdf') {
    const buffer = fs.readFileSync(safePath);
    const data = await pdfParse(buffer);
    return data.text;
  }

  // DOCX (modern Word)
  if (
    mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    ext === 'docx'
  ) {
    const result = await mammoth.extractRawText({ path: safePath });
    return result.value;
  }

  // DOC (legacy Word) — best-effort plain text
  if (mimetype === 'application/msword' || ext === 'doc') {
    try {
      return fs.readFileSync(safePath, 'utf-8');
    } catch {
      return '[Could not extract text from .doc file]';
    }
  }

  // Excel (XLSX, XLS)
  if (
    mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    mimetype === 'application/vnd.ms-excel' ||
    ext === 'xlsx' ||
    ext === 'xls'
  ) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(safePath);
    const sheets: string[] = [];
    workbook.eachSheet((sheet) => {
      const rows: string[] = [];
      sheet.eachRow((row) => {
        const values = Array.isArray(row.values) ? row.values.slice(1) : [];
        rows.push(values.map((v) => String(v ?? '')).join(','));
      });
      sheets.push(`[Sheet: ${sheet.name}]\n${rows.join('\n')}`);
    });
    return sheets.join('\n\n');
  }

  // PowerPoint (PPTX)
  if (
    mimetype === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
    ext === 'pptx'
  ) {
    try {
      const zip = new AdmZip(safePath);
      const entries = zip.getEntries();
      const texts: string[] = [];
      for (const entry of entries) {
        if (
          entry.entryName.startsWith('ppt/slides/slide') &&
          entry.entryName.endsWith('.xml')
        ) {
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

  // Text-based files
  if (
    mimetype.startsWith('text/') ||
    mimetype === 'application/json' ||
    mimetype === 'application/xml' ||
    mimetype === 'application/csv' ||
    ['csv', 'json', 'xml', 'txt', 'md', 'yaml', 'yml', 'toml'].includes(ext)
  ) {
    return fs.readFileSync(safePath, 'utf-8');
  }

  // Fallback
  try {
    return fs.readFileSync(safePath, 'utf-8');
  } catch {
    return '[Binary file — content could not be extracted]';
  }
}

// ---------------------------------------------------------------------------
// Supported file types (for frontend validation)
// ---------------------------------------------------------------------------

export const SUPPORTED_TYPES: Record<string, string> = {
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

export const SUPPORTED_EXTENSIONS =
  '.pdf,.docx,.doc,.xlsx,.xls,.pptx,.csv,.json,.xml,.txt,.md,.yaml,.yml';

// ---------------------------------------------------------------------------
// Multer middleware with auto text extraction
// ---------------------------------------------------------------------------

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});

const upload: Multer = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max
});

export const uploadAndExtract = {
  single(fieldName: string): RequestHandler[] {
    return [
      upload.single(fieldName),
      async (req: Request, _res: Response, next: NextFunction) => {
        if (!req.file) return next();
        try {
          req.extractedText = await extractText(
            req.file.path,
            req.file.mimetype,
            req.file.originalname
          );
          next();
        } catch (err) {
          next(err);
        } finally {
          try {
            fs.unlinkSync(resolveUploadPath(req.file.path));
          } catch {
            /* noop */
          }
        }
      },
    ];
  },

  array(fieldName: string, maxCount?: number): RequestHandler[] {
    return [
      upload.array(fieldName, maxCount),
      async (req: Request, _res: Response, next: NextFunction) => {
        const files = (req.files as Express.Multer.File[]) || [];
        if (files.length === 0) return next();
        try {
          req.extractedTexts = await Promise.all(
            files.map(async (f) => ({
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
          for (const f of files) {
            try {
              fs.unlinkSync(resolveUploadPath(f.path));
            } catch {
              /* noop */
            }
          }
        }
      },
    ];
  },
};
