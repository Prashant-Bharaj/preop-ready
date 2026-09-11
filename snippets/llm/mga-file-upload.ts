/**
 * scopes: [backend]
 * flags: [ai-rag, file-uploads]
 * description: Upload end-user files (TypeScript) to the MGA assistant's knowledge base.
 */

/**
 * MGA Assistant File Upload (TypeScript)
 *
 * Posts a file to /assistants/{id}/files. MGA indexes the content and the
 * `uploaded_docs` tool (default on /chat/agent) surfaces relevant chunks
 * in subsequent chat turns. This is the simplest RAG path — no embeddings
 * pipeline, no vectordb, MGA does it all.
 *
 * Supported file types per MGA's docs: PDF, DOCX, XLSX, PPTX, TXT, MD, CSV.
 *
 * When to use the uploaded_docs path vs. building your own pgvector RAG:
 *   - uploaded_docs: small/medium corpus (<100 files), no per-tenant
 *     isolation needed, fastest to ship
 *   - your own pgvector + mga-embedding.ts: large corpus, per-user/tenant
 *     isolation, custom retrieval logic, on-the-fly re-ingestion
 *
 * Dependencies: none (Node 18+ has FormData, Blob, fetch).
 *
 * Environment variables:
 *   MGA_API_KEY, MGA_BASE_URL, MGA_ASSISTANT_ID (written by harness).
 *
 * Example:
 *   import { uploadFile } from './mga-file-upload.js';
 *   const fileId = await uploadFile({
 *     buffer: req.file.buffer,
 *     filename: req.file.originalname,
 *     mime: req.file.mimetype,
 *   });
 */

const MGA_API_KEY: string | undefined = process.env.MGA_API_KEY;
const MGA_BASE_URL: string =
  process.env.MGA_BASE_URL || 'https://chat.int.bayer.com/api/v2';
const MGA_ASSISTANT_ID: string | undefined = process.env.MGA_ASSISTANT_ID;

if (!MGA_API_KEY || !MGA_ASSISTANT_ID) {
  throw new Error(
    'MGA not configured. Set MGA_API_KEY and MGA_ASSISTANT_ID in env.'
  );
}

export interface UploadFileArgs {
  buffer: Buffer;
  filename: string;
  mime: string;
}

interface UploadFileResponse {
  id?: string;
  [key: string]: unknown;
}

/**
 * Upload a file to the assistant's knowledge base.
 * Returns the MGA file id.
 */
export async function uploadFile({
  buffer,
  filename,
  mime,
}: UploadFileArgs): Promise<string> {
  if (!Buffer.isBuffer(buffer)) throw new Error('buffer must be a Buffer');
  if (!filename) throw new Error('filename required');
  if (!mime) throw new Error('mime required');

  const fd = new FormData();
  fd.append('file', new Blob([buffer], { type: mime }), filename);

  const url = `${MGA_BASE_URL.replace(/\/$/, '')}/assistants/${MGA_ASSISTANT_ID}/files`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${MGA_API_KEY}` },
    body: fd,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(
      `MGA file upload failed: HTTP ${res.status} — ${txt.slice(0, 300)}`
    );
  }
  const data = (await res.json()) as UploadFileResponse;
  if (!data.id) {
    throw new Error(
      `MGA file upload returned no id: ${JSON.stringify(data).slice(0, 200)}`
    );
  }
  return data.id;
}
