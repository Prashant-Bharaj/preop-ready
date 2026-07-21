/**
 * SNIPPET: MGA Knowledge Base Client (managed RAG)
 * CATEGORY: AI / LLM
 * LANGUAGE: JavaScript (Node.js)
 * STATUS: Ready
 *
 * DESCRIPTION:
 *   The PREFERRED path for "chat with my documents" / document QA:
 *   myGenAssist's v3 Knowledge Base does chunking, embedding, storage and
 *   retrieval as a managed service — no custom pipeline, no own vector DB.
 *   Flow: create KB -> upload documents -> attach -> poll status -> retrieve
 *   relevant chunks -> feed them + the question to chat completions
 *   (snippets/llm/bayer-llm-client.js).
 *   Falls back to mock responses when credentials are not configured (local dev).
 *
 * DEPENDENCIES:
 *   npm install axios     (uploads use Node's global fetch/FormData; Node >= 18)
 *
 * ENVIRONMENT VARIABLES (GitHub Secrets -> Container):
 *   APP_SECRET_1  ->  SECRET_1   ->  MGA endpoint URL
 *   APP_API_KEY   ->  API_KEY    ->  MGA API key (Bearer token)
 *   Optional: MGA_PROJECT        ->  project identifier header (mga-project)
 *   For local development: LLM_ENDPOINT, LLM_API_KEY in backend/.env
 *
 * USAGE:
 *   const kb = require('./knowledge-base-client');
 *
 *   // One-time setup (e.g. admin route or startup script)
 *   const base = await kb.createKnowledgeBase({ name: 'project-docs' });
 *   const docs = await kb.uploadDocuments([{ name: 'guide.pdf', buffer }]);
 *   await kb.attachDocuments(base.id, docs.map(d => d.id));
 *
 *   // Per question
 *   const context = await kb.retrieveContext(base.id, userQuestion);
 *   const answer = await callLLM(userQuestion, {
 *     systemPrompt: `Answer using ONLY this context:\n${context}`,
 *   });
 */

const axios = require('axios');

const KB_CONFIG = {
  endpoint: process.env.SECRET_1 || process.env.LLM_ENDPOINT,
  apiKey: process.env.API_KEY || process.env.LLM_API_KEY,
  project: process.env.MGA_PROJECT || null,
  timeoutMs: 60000,
};

function isConfigured() {
  return Boolean(KB_CONFIG.endpoint && KB_CONFIG.apiKey);
}

function headers(extra = {}) {
  const h = { Authorization: `Bearer ${KB_CONFIG.apiKey}`, ...extra };
  if (KB_CONFIG.project) h['mga-project'] = KB_CONFIG.project;
  return h;
}

/**
 * Create a knowledge base.
 * Body is application/x-www-form-urlencoded per the MGA API.
 * @param {Object} opts
 * @param {string} opts.name - knowledge base name (required)
 * @param {string} [opts.description]
 * @param {string} [opts.access='private'] - 'private' or 'public'
 * @param {string} [opts.mediaType='DOCUMENTS'] - media type supported by the KB
 * @param {string} [opts.contentType='DOCUMENTS'] - DOCUMENTS for RAG, SKILLS for agent skills
 */
async function createKnowledgeBase({ name, description, access = 'private', mediaType = 'DOCUMENTS', contentType = 'DOCUMENTS' }) {
  if (!isConfigured()) {
    console.warn('[KB] Not configured - returning mock knowledge base');
    return { id: 'mock-kb-id', name, mock: true };
  }
  const body = new URLSearchParams({ name, access, media_type: mediaType, content_type: contentType });
  if (description) body.set('description', description);
  const res = await axios.post(`${KB_CONFIG.endpoint}/knowledge`, body, {
    headers: headers({ 'Content-Type': 'application/x-www-form-urlencoded' }),
    timeout: KB_CONFIG.timeoutMs,
  });
  return res.data;
}

/**
 * Upload documents (multipart). Returns the created document records.
 * @param {Array<{name: string, buffer: Buffer, mimeType?: string}>} files
 * @param {string} [purpose='file_upload'] - file_upload | onedrive_sync | sharepoint_sync | conversation_upload
 */
async function uploadDocuments(files, purpose = 'file_upload') {
  if (!isConfigured()) {
    console.warn('[KB] Not configured - returning mock documents');
    return files.map((f, i) => ({ id: `mock-doc-${i}`, name: f.name, mock: true }));
  }
  const form = new FormData();
  for (const f of files) {
    form.append('files', new Blob([f.buffer], { type: f.mimeType || 'application/octet-stream' }), f.name);
  }
  const url = new URL(`${KB_CONFIG.endpoint}/knowledge/documents`);
  url.searchParams.set('content_type', 'DOCUMENTS');
  url.searchParams.set('purpose', purpose);
  const res = await fetch(url, { method: 'POST', headers: headers(), body: form });
  if (!res.ok) throw new Error(`KB upload failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  // VERIFY: response is a list of document records; adjust the id field if
  // the API returns e.g. document_id instead of id.
  return data;
}

/**
 * Attach previously uploaded documents to a knowledge base.
 * VERIFY: body shape assumed { document_ids: [...] } — confirm against the
 * POST /knowledge/{id}/documents schema and adjust if needed.
 */
async function attachDocuments(knowledgeBaseId, documentIds) {
  if (!isConfigured()) return { attached: documentIds.length, mock: true };
  const res = await axios.post(
    `${KB_CONFIG.endpoint}/knowledge/${knowledgeBaseId}/documents`,
    { document_ids: documentIds },
    { headers: headers(), timeout: KB_CONFIG.timeoutMs }
  );
  return res.data;
}

/** Processing status of the KB's documents (poll until ready before retrieving). */
async function getDocumentsStatus(knowledgeBaseId) {
  if (!isConfigured()) return { status: 'ready', mock: true };
  const res = await axios.get(
    `${KB_CONFIG.endpoint}/knowledge/${knowledgeBaseId}/documents/status`,
    { headers: headers(), timeout: KB_CONFIG.timeoutMs }
  );
  return res.data;
}

/**
 * Retrieve relevant chunks for a query.
 * @returns raw retrieval response (chunks with scores)
 */
async function retrieve(knowledgeBaseId, query, { topK = 10, method = 'semantic_search', scoreThresholdEnabled = false } = {}) {
  if (!isConfigured()) {
    console.warn('[KB] Not configured - returning mock retrieval');
    return { chunks: [{ text: `Mock context for: ${query}`, score: 1 }], mock: true };
  }
  const res = await axios.post(
    `${KB_CONFIG.endpoint}/knowledge/${knowledgeBaseId}/retrieve`,
    {
      query,
      retrieval_settings: {
        retrieval_method: method,
        score_threshold_enabled: scoreThresholdEnabled,
        top_k: topK,
      },
    },
    { headers: headers(), timeout: KB_CONFIG.timeoutMs }
  );
  return res.data;
}

/**
 * Convenience: retrieve and join the chunk texts into one context string
 * ready to inject into a completion prompt.
 * VERIFY: adjusts automatically to chunks/results/documents arrays with
 * text/content fields — confirm against a real retrieve response.
 */
async function retrieveContext(knowledgeBaseId, query, options = {}) {
  const data = await retrieve(knowledgeBaseId, query, options);
  const items = data.chunks || data.results || data.documents || [];
  return items
    .map((c) => c.text || c.content || '')
    .filter(Boolean)
    .join('\n---\n');
}

module.exports = {
  createKnowledgeBase,
  uploadDocuments,
  attachDocuments,
  getDocumentsStatus,
  retrieve,
  retrieveContext,
};
