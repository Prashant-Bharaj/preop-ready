'use strict';

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');
const { OpenAI } = require('openai');
const rateLimit = require('express-rate-limit');
const { applySecurityMiddleware, globalErrorHandler } = require('./middleware/sanitize');

const app = express();
const PORT = 3000;

// ---- Database ----
const pool = new Pool({
  host: process.env.DATABASE_HOST || 'localhost',
  port: parseInt(process.env.DATABASE_PORT || '5432', 10),
  database: process.env.DATABASE_NAME || 'ragapp',
  user: process.env.DATABASE_USER || 'ragapp_user',
  password: process.env.DATABASE_PASSWORD || 'localdev123',
});

// ---- OpenAI ----
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || 'no-key-set' });

// ---- Upload storage ----
const UPLOAD_DIR = process.env.UPLOAD_DIR || '/tmp/uploads';
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (_req, file, cb) => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    cb(null, `${unique}${path.extname(file.originalname)}`);
  },
});

const ALLOWED_MIMES = new Set([
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/x-markdown',
]);

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIMES.has(file.mimetype) || /\.(txt|md|pdf)$/i.test(file.originalname)) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF, TXT, and MD files are allowed'));
    }
  },
});

// ---- Middleware ----
app.use(cors());
app.use(express.json({ limit: '1mb' }));
applySecurityMiddleware(app);

const uploadLimiter = rateLimit({ windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false });
const askLimiter = rateLimit({ windowMs: 60_000, max: 20, standardHeaders: true, legacyHeaders: false });

// ---- Helpers ----

function getUser(req) {
  const oidcData = req.headers['x-amzn-oidc-data'];
  if (oidcData) {
    try {
      const parts = oidcData.split('.');
      if (parts.length >= 2) {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
        return { sub: payload.sub || 'unknown', email: payload.email || '' };
      }
    } catch (_e) { /* ignore parse errors */ }
  }
  return { sub: 'local-dev-user', email: 'dev@local' };
}

function isPositiveInt(val) {
  const n = parseInt(val, 10);
  return !isNaN(n) && n > 0 && n.toString() === String(val).trim();
}

function chunkText(text, chunkWords = 500, overlapWords = 50) {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const chunks = [];
  let i = 0;
  while (i < words.length) {
    chunks.push(words.slice(i, i + chunkWords).join(' '));
    if (i + chunkWords >= words.length) break;
    i += chunkWords - overlapWords;
  }
  return chunks;
}

async function extractText(filePath, mimetype, filename) {
  if (mimetype === 'application/pdf' || filename.toLowerCase().endsWith('.pdf')) {
    try {
      // Lazy-import to avoid pdf-parse's debug-mode side effects at module load
      const pdfParse = require('pdf-parse');
      const buffer = fs.readFileSync(filePath);
      const data = await pdfParse(buffer);
      return data.text || '';
    } catch (_err) {
      // Fall back to raw read if pdf-parse fails
      return fs.readFileSync(filePath, 'latin1');
    }
  }
  return fs.readFileSync(filePath, 'utf-8');
}

async function processDocument(docId, filePath, mimetype, filename) {
  try {
    const text = await extractText(filePath, mimetype, filename);
    const chunks = chunkText(text);

    let chunkCount = 0;
    for (let i = 0; i < chunks.length; i++) {
      const embResp = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: chunks[i],
      });
      const vec = embResp.data[0].embedding;
      const vecStr = `[${vec.join(',')}]`;
      await pool.query(
        'INSERT INTO chunks (document_id, chunk_index, content, embedding) VALUES ($1, $2, $3, $4::vector)',
        [docId, i, chunks[i], vecStr],
      );
      chunkCount++;
    }

    await pool.query(
      "UPDATE documents SET status = 'indexed', chunk_count = $1, error_message = NULL WHERE id = $2",
      [chunkCount, docId],
    );
  } catch (err) {
    console.error('Document processing failed:', { docId, error: err.message });
    await pool.query(
      "UPDATE documents SET status = 'failed', error_message = $1 WHERE id = $2",
      [String(err.message), docId],
    ).catch(() => {});
  }
}

// ---- Routes ----

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// GET /documents?limit=50&offset=0
app.get('/documents', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const result = await pool.query(
      `SELECT id, filename, mime_type, size_bytes, uploaded_by, uploaded_at,
              status, chunk_count, error_message
       FROM documents
       ORDER BY uploaded_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    res.json({ documents: result.rows });
  } catch (err) {
    next(err);
  }
});

// POST /documents  (multipart, field: "file")
app.post('/documents', uploadLimiter, (req, res, next) => {
  upload.single('file')(req, res, async (err) => {
    if (err) {
      const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      return res.status(status).json({
        error: 'UPLOAD_ERROR',
        message: err.message,
        statusCode: status,
      });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'BAD_REQUEST', message: 'No file uploaded', statusCode: 400 });
    }

    const user = getUser(req);
    const { originalname, mimetype, size, path: filePath } = req.file;

    if (originalname.length > 255) {
      fs.unlink(filePath, () => {});
      return res.status(400).json({
        error: 'BAD_REQUEST',
        message: 'Filename too long (max 255 characters)',
        statusCode: 400,
      });
    }

    let docId;
    try {
      const result = await pool.query(
        "INSERT INTO documents (filename, mime_type, size_bytes, uploaded_by, status) VALUES ($1, $2, $3, $4, 'pending') RETURNING id",
        [originalname, mimetype, size, user.sub],
      );
      docId = result.rows[0].id;
    } catch (dbErr) {
      fs.unlink(filePath, () => {});
      return next(dbErr);
    }

    res.status(202).json({ id: docId, status: 'pending' });

    // Process asynchronously — do not await
    processDocument(docId, filePath, mimetype, originalname).catch((e) => {
      console.error('Async processing error:', { docId, error: e.message });
    });
  });
});

// DELETE /documents/:id
app.delete('/documents/:id', async (req, res, next) => {
  try {
    if (!isPositiveInt(req.params.id)) {
      return res.status(400).json({ error: 'BAD_REQUEST', message: 'Invalid document ID', statusCode: 400 });
    }
    const user = getUser(req);
    const docId = parseInt(req.params.id, 10);

    const doc = await pool.query('SELECT uploaded_by FROM documents WHERE id = $1', [docId]);
    if (doc.rows.length === 0) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Document not found', statusCode: 404 });
    }
    if (doc.rows[0].uploaded_by !== user.sub) {
      return res.status(403).json({
        error: 'FORBIDDEN',
        message: 'You may only delete your own documents',
        statusCode: 403,
      });
    }

    await pool.query('DELETE FROM documents WHERE id = $1', [docId]);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// POST /ask  { question }
app.post('/ask', askLimiter, async (req, res, next) => {
  try {
    const { question } = req.body || {};
    if (!question || typeof question !== 'string' || !question.trim()) {
      return res.status(400).json({ error: 'BAD_REQUEST', message: 'question is required', statusCode: 400 });
    }
    if (question.length > 1000) {
      return res.status(400).json({
        error: 'BAD_REQUEST',
        message: 'question must be 1000 characters or fewer',
        statusCode: 400,
      });
    }

    const embResp = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: question.trim(),
    });
    const qVec = embResp.data[0].embedding;
    const qVecStr = `[${qVec.join(',')}]`;

    const result = await pool.query(
      `SELECT c.document_id, c.chunk_index, c.content, d.filename
       FROM chunks c
       JOIN documents d ON d.id = c.document_id
       WHERE c.embedding IS NOT NULL
       ORDER BY c.embedding <=> $1::vector
       LIMIT 5`,
      [qVecStr],
    );

    if (result.rows.length === 0) {
      return res.json({
        answer: 'No indexed documents found. Please upload documents first.',
        citations: [],
      });
    }

    const context = result.rows
      .map((r, i) => `[${i + 1}] (${r.filename}): ${r.content}`)
      .join('\n\n');

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'Answer the question using only the provided context. Cite sources with [1], [2], etc.',
        },
        {
          role: 'user',
          content: `Context:\n${context}\n\nQuestion: ${question.trim()}`,
        },
      ],
      max_tokens: 1000,
    });

    res.json({
      answer: completion.choices[0].message.content,
      citations: result.rows.map((r) => ({
        document_id: r.document_id,
        filename: r.filename,
        chunk_index: r.chunk_index,
        snippet: r.content.slice(0, 200),
      })),
    });
  } catch (err) {
    next(err);
  }
});

// Global error handler — must be last
app.use(globalErrorHandler);

app.listen(PORT, () => {
  console.log(`Backend listening on port ${PORT}`);
});