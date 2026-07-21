/**
 * SNIPPET: MGA RAG Tools (embeddings, rerank, chunking, model list)
 * CATEGORY: AI / LLM
 * LANGUAGE: JavaScript (Node.js)
 * STATUS: Ready
 *
 * DESCRIPTION:
 *   Building blocks for CUSTOM semantic search over the app's own data
 *   (DB rows, user content) — embed with MGA, store vectors in the app's
 *   vector DB (see .platform-rules/scope-vectordb.md), rerank candidates.
 *   For DOCUMENT collections prefer the managed path instead:
 *   snippets/llm/knowledge-base-client.js (no vector DB needed).
 *   Falls back to mock responses when credentials are not configured (local dev).
 *
 * DEPENDENCIES:
 *   npm install axios
 *
 * ENVIRONMENT VARIABLES (GitHub Secrets -> Container):
 *   APP_SECRET_1  ->  SECRET_1   ->  MGA endpoint URL
 *   APP_API_KEY   ->  API_KEY    ->  MGA API key (Bearer token)
 *   Optional: MGA_PROJECT        ->  project identifier header (mga-project)
 *   For local development: LLM_ENDPOINT, LLM_API_KEY in backend/.env
 *
 * USAGE:
 *   const { embed, rerank, chunkText, listModels } = require('./rag-tools');
 *
 *   const chunks = await chunkText(longText, { chunk_size: 500, chunk_overlap: 50 });
 *   const vectors = await embed(chunks, { model: 'text-embedding-model' });
 *   // ... store vectors in pgvector/Chroma/Qdrant, query top-20 ...
 *   const best = await rerank(question, candidateTexts, { topN: 5 });
 */

const axios = require('axios');

const CONFIG = {
  endpoint: process.env.SECRET_1 || process.env.LLM_ENDPOINT,
  apiKey: process.env.API_KEY || process.env.LLM_API_KEY,
  project: process.env.MGA_PROJECT || null,
  timeoutMs: 60000,
};

function isConfigured() {
  return Boolean(CONFIG.endpoint && CONFIG.apiKey);
}

function headers() {
  const h = { Authorization: `Bearer ${CONFIG.apiKey}` };
  if (CONFIG.project) h['mga-project'] = CONFIG.project;
  return h;
}

/**
 * Create embeddings (OpenAI-compatible /embeddings).
 * @param {string[]} texts
 * @param {Object} [opts] - { model } (required in production; ask GET /models)
 * @returns {Promise<number[][]>} one vector per input text
 */
async function embed(texts, { model } = {}) {
  if (!isConfigured()) {
    console.warn('[RAG] Not configured - returning mock embeddings');
    return texts.map(() => Array(8).fill(0));
  }
  const res = await axios.post(
    `${CONFIG.endpoint}/embeddings`,
    { model, input: texts },
    { headers: headers(), timeout: CONFIG.timeoutMs }
  );
  return res.data.data.map((d) => d.embedding);
}

/**
 * Rerank candidate documents against a query.
 * @param {string} query
 * @param {string[]} documents - candidate texts (e.g. vector-search top-20)
 * @param {Object} [opts] - { model, topN, returnDocuments=true }
 * @returns rerank response: ranked items with relevance scores and indices
 */
async function rerank(query, documents, { model, topN, returnDocuments = true } = {}) {
  if (!isConfigured()) {
    console.warn('[RAG] Not configured - returning mock reranking');
    return { results: documents.map((d, index) => ({ index, relevance_score: 1 - index * 0.1 })) };
  }
  const body = { model, query, documents, return_documents: returnDocuments };
  if (topN) body.top_n = topN;
  const res = await axios.post(`${CONFIG.endpoint}/rerank`, body, {
    headers: headers(),
    timeout: CONFIG.timeoutMs,
  });
  return res.data;
}

/**
 * Split text into chunks server-side (use before embed()).
 * @param {string} text
 * @param {Object} [settings] - chunking settings; defaults to recursive splitting
 * @returns {Promise<string[]>} chunk texts
 */
async function chunkText(text, settings = {}) {
  if (!isConfigured()) {
    console.warn('[RAG] Not configured - returning single mock chunk');
    return [text];
  }
  const res = await axios.post(
    `${CONFIG.endpoint}/chunking/chunk`,
    {
      text,
      settings: {
        chunking_method: 'recursive_character',
        chunk_size: 500,
        chunk_overlap: 50,
        ...settings,
      },
    },
    { headers: headers(), timeout: CONFIG.timeoutMs }
  );
  // VERIFY: adjust if ChunkingOutput nests chunks differently
  return res.data.chunks || res.data;
}

/**
 * List available models (chat, embedding, rerank). Use to offer model
 * selection in app settings instead of hardcoding names.
 */
async function listModels({ includeHidden = false, includeAliases = true } = {}) {
  if (!isConfigured()) {
    console.warn('[RAG] Not configured - returning mock model list');
    return [{ id: 'mock-model' }];
  }
  const res = await axios.get(`${CONFIG.endpoint}/models`, {
    params: { include_hidden_models: includeHidden, include_aliases: includeAliases },
    headers: headers(),
    timeout: CONFIG.timeoutMs,
  });
  // OpenAI-compatible ModelList: { data: [{ id, ... }] }
  return res.data.data || res.data.models || res.data;
}

module.exports = { embed, rerank, chunkText, listModels };
