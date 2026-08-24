/**
 * embed-helper-generator.js — emits `backend/src/lib/embed.ts` with a
 * canonical MGA `/embeddings` client.
 *
 * Emitted when the contract has `flags: [..., 'ai-rag']` OR a
 * `mgaAssistants` array. Otherwise returns null.
 *
 * The helper enforces:
 *   - reads MGA_API_KEY + MGA_BASE_URL from env (no hardcoding)
 *   - calls `${baseUrl}/embeddings` (OpenAI-compat shape)
 *   - throws on HTTP failure or missing fields (NO fallback embedding —
 *     fallbacks were one of the drift patterns we saw on tHARD; the
 *     correct response to MGA being unreachable is to fail loudly, not
 *     to invent vectors that silently degrade search quality)
 */

import { PLATFORM_EMBEDDING_MODEL } from '../../config/defaults.js';

export function shouldEmitEmbedHelper(contract) {
  const flags = contract?.flags || [];
  if (Array.isArray(flags) && flags.includes('ai-rag')) return true;
  if (Array.isArray(contract?.mgaAssistants) && contract.mgaAssistants.length > 0) return true;
  return false;
}

export function generateEmbedHelper(contract) {
  if (!shouldEmitEmbedHelper(contract)) return null;

  const lines = [];
  lines.push(`// AUTO-GENERATED — DO NOT EDIT — emitted because contract has flags=['ai-rag'] or mgaAssistants`);
  lines.push(`// Generated ${new Date().toISOString()}`);
  lines.push('');
  lines.push(`/**`);
  lines.push(` * MGA /embeddings client. Calls the platform's OpenAI-compatible`);
  lines.push(` * embeddings endpoint with the user-app's MGA credentials and`);
  lines.push(` * returns the raw embedding vector.`);
  lines.push(` *`);
  lines.push(` * Env vars (set by the harness during /confirm):`);
  lines.push(` *   MGA_API_KEY  — Bearer token`);
  lines.push(` *   MGA_BASE_URL — e.g. https://chat.int.bayer.com/api/v2`);
  lines.push(` *   MGA_EMBEDDING_MODEL — optional override; defaults to text-embedding-3-small`);
  lines.push(` *`);
  lines.push(` * Throws on any failure. Do NOT add a fallback to a deterministic`);
  lines.push(` * hash-bag embedding — that masks MGA outages with silently-degraded`);
  lines.push(` * search results. Fail loudly so the operator can intervene.`);
  lines.push(` */`);
  lines.push(`export async function embedText(text: string): Promise<number[]> {`);
  lines.push(`  const apiKey = process.env.MGA_API_KEY;`);
  lines.push(`  const baseUrl = process.env.MGA_BASE_URL;`);
  lines.push(`  const model = process.env.MGA_EMBEDDING_MODEL || '${PLATFORM_EMBEDDING_MODEL}';`);
  lines.push(`  if (!apiKey || !baseUrl) {`);
  lines.push(`    throw new Error('embedText: MGA_API_KEY and MGA_BASE_URL must be set in env');`);
  lines.push(`  }`);
  lines.push(`  const url = \`\${baseUrl.replace(/\\/$/, '')}/embeddings\`;`);
  lines.push(`  const res = await fetch(url, {`);
  lines.push(`    method: 'POST',`);
  lines.push(`    headers: {`);
  lines.push(`      'Content-Type': 'application/json',`);
  lines.push(`      'Authorization': \`Bearer \${apiKey}\`,`);
  lines.push(`    },`);
  lines.push(`    body: JSON.stringify({ input: text, model }),`);
  lines.push(`  });`);
  lines.push(`  if (!res.ok) {`);
  lines.push(`    const body = await res.text();`);
  lines.push(`    throw new Error(\`embedText: MGA /embeddings HTTP \${res.status} — \${body.slice(0, 200)}\`);`);
  lines.push(`  }`);
  lines.push(`  const data = await res.json() as { data?: Array<{ embedding?: number[] }> };`);
  lines.push(`  const vec = data?.data?.[0]?.embedding;`);
  lines.push(`  if (!Array.isArray(vec) || vec.length === 0) {`);
  lines.push(`    throw new Error('embedText: MGA response missing data[0].embedding');`);
  lines.push(`  }`);
  lines.push(`  return vec;`);
  lines.push(`}`);
  lines.push('');

  return { source: lines.join('\n') };
}
