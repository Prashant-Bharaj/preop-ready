/**
 * scopes: [backend, vectordb]
 * flags: [ai-rag]
 * description: Compute MGA embeddings (TypeScript) for vector search / RAG.
 */

/**
 * MGA Embeddings (TypeScript)
 *
 * Calls MGA's /embeddings endpoint to convert text into vectors. Use for
 * RAG: embed your documents at ingest time, embed user queries at search
 * time, ANN-search them with your vectordb (pgvector).
 *
 * Models:
 *   - text-embedding-3-large (default — 3072 dims, highest quality)
 *   - text-embedding-3-small (1536 dims, fast & cheap)
 *
 * Both support `dimensions` to truncate the output if your DB column has
 * a smaller fixed size (e.g. 768 for legacy pgvector setups).
 *
 * Environment variables:
 *   MGA_API_KEY, MGA_BASE_URL          — written by harness
 *   MGA_EMBEDDING_MODEL                — optional; defaults to text-embedding-3-large
 *
 * Example:
 *   import { embed, embedMany } from './mga-embedding.js';
 *   const vec  = await embed('aspirin contraindications');
 *   const vecs = await embedMany(['query A', 'query B']);
 *   const v768 = await embed('text', { dimensions: 768 });
 */

const MGA_API_KEY: string | undefined = process.env.MGA_API_KEY;
const MGA_BASE_URL: string =
  process.env.MGA_BASE_URL || 'https://chat.int.bayer.com/api/v2';
const MGA_EMBEDDING_MODEL: string =
  process.env.MGA_EMBEDDING_MODEL || 'text-embedding-3-large';

if (!MGA_API_KEY) {
  throw new Error('MGA not configured. Set MGA_API_KEY in env.');
}

export interface EmbeddingOptions {
  model?: string;
  dimensions?: number;
}

interface EmbeddingRequestBody {
  model: string;
  input: string[];
  encoding_format: 'float';
  dimensions?: number;
}

interface EmbeddingResponse {
  data?: Array<{ embedding: number[] }>;
}

/**
 * Embed a single string.
 */
export async function embed(
  text: string,
  opts: EmbeddingOptions = {}
): Promise<number[]> {
  const [vec] = await embedMany([text], opts);
  return vec;
}

/**
 * Embed many strings in one call.
 */
export async function embedMany(
  texts: string[],
  opts: EmbeddingOptions = {}
): Promise<number[][]> {
  if (!Array.isArray(texts) || texts.length === 0) return [];
  const body: EmbeddingRequestBody = {
    model: opts.model || MGA_EMBEDDING_MODEL,
    input: texts,
    encoding_format: 'float',
  };
  if (typeof opts.dimensions === 'number') body.dimensions = opts.dimensions;

  const res = await fetch(`${MGA_BASE_URL.replace(/\/$/, '')}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${MGA_API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(
      `MGA embeddings failed: HTTP ${res.status} — ${txt.slice(0, 300)}`
    );
  }
  const data = (await res.json()) as EmbeddingResponse;
  return (data.data || []).map((item) => item.embedding);
}
