/**
 * Pricing table + cost helper for MGA-routed model calls.
 *
 * Section M item 2 (HARNESS_EVOLUTION.md W1.TEL): every per-call
 * llm-calls.jsonl entry gets a `costUsd` field driven by this table. The
 * run-summary writer (Section M item 6) aggregates these into a per-build
 * total.
 *
 * **Pricing units**: USD per 1,000,000 tokens (consistent with how every
 * upstream provider publishes their price page). `computeCost` returns a
 * float rounded to 6 decimal places. Returns `null` (not 0) for unknown
 * models so callers can disambiguate "free" from "we don't know".
 *
 * **Sources** (as-of Jan 2026, the codebase's knowledge cutoff):
 *   - Anthropic: https://www.anthropic.com/pricing
 *   - OpenAI:    https://openai.com/api/pricing
 *   - Google:    https://ai.google.dev/pricing
 * When a future model lands, update the corresponding row + the comment
 * citing the source date; no code change should be required elsewhere.
 *
 * **Cached tokens**: most providers bill cached / context-cache reads at a
 * fraction of the prompt rate (~10x cheaper for Anthropic prompt-caching,
 * ~2x for OpenAI). If `cachedPerMillion` is missing for a row we fall
 * back to `promptPerMillion` (conservative — never undercount).
 */

// ── Pricing table ────────────────────────────────────────────────────────
// Keys are the *normalized* model name (see normalizeModelName below).
// Numbers are USD per 1M tokens.
const PRICING = {
  // ─ Anthropic (Claude family) ─────────────────────────────────────────
  // Source: Anthropic public pricing 2026-01.
  'claude-opus-4-7':    { promptPerMillion: 15.00, completionPerMillion: 75.00, cachedPerMillion: 1.50 },
  'claude-opus-4-6':    { promptPerMillion: 15.00, completionPerMillion: 75.00, cachedPerMillion: 1.50 },
  'claude-sonnet-5':    { promptPerMillion:  3.00, completionPerMillion: 15.00, cachedPerMillion: 0.30 },
  'claude-sonnet-4-6':  { promptPerMillion:  3.00, completionPerMillion: 15.00, cachedPerMillion: 0.30 },
  'claude-sonnet-4-5':  { promptPerMillion:  3.00, completionPerMillion: 15.00, cachedPerMillion: 0.30 },
  'claude-haiku-4-5':   { promptPerMillion:  1.00, completionPerMillion:  5.00, cachedPerMillion: 0.10 },

  // ─ OpenAI (GPT family) ───────────────────────────────────────────────
  // Source: OpenAI public pricing 2026-01.
  'gpt-4o':             { promptPerMillion:  2.50, completionPerMillion: 10.00, cachedPerMillion: 1.25 },
  'gpt-4o-mini':        { promptPerMillion:  0.15, completionPerMillion:  0.60, cachedPerMillion: 0.075 },
  'gpt-5':              { promptPerMillion:  1.25, completionPerMillion: 10.00, cachedPerMillion: 0.125 },
  'gpt-5-mini':         { promptPerMillion:  0.25, completionPerMillion:  2.00, cachedPerMillion: 0.025 },
  'o4-mini':            { promptPerMillion:  1.10, completionPerMillion:  4.40, cachedPerMillion: 0.275 },

  // ─ Google (Gemini family) ────────────────────────────────────────────
  // Source: Google AI public pricing 2026-01.
  'gemini-2-5-pro':     { promptPerMillion:  1.25, completionPerMillion: 10.00, cachedPerMillion: 0.31 },
  'gemini-2-5-flash':   { promptPerMillion:  0.30, completionPerMillion:  2.50, cachedPerMillion: 0.075 },

  // ─ Embeddings (OpenAI) ───────────────────────────────────────────────
  // Source: OpenAI public pricing 2026-01. Embeddings have no completion
  // tokens — completionPerMillion = 0; cached tier not offered.
  'text-embedding-3-large': { promptPerMillion: 0.13, completionPerMillion: 0, cachedPerMillion: 0.13 },
  'text-embedding-3-small': { promptPerMillion: 0.02, completionPerMillion: 0, cachedPerMillion: 0.02 },
};

// ── Aliases ──────────────────────────────────────────────────────────────
// Map common short-form / vendor-specific names to the canonical normalized
// key in PRICING above. Applied after normalizeModelName.
const ALIASES = {
  // Anthropic short forms
  'opus-4-7':       'claude-opus-4-7',
  'opus-4-6':       'claude-opus-4-6',
  'sonnet-4-6':     'claude-sonnet-4-6',
  'sonnet-4-5':     'claude-sonnet-4-5',
  'haiku-4-5':      'claude-haiku-4-5',
  // Claude with full provider prefix used by some APIs
  'anthropic-claude-opus-4-7':   'claude-opus-4-7',
  'anthropic-claude-sonnet-4-5': 'claude-sonnet-4-5',
  // OpenAI short forms
  'gpt5':           'gpt-5',
  'gpt5-mini':      'gpt-5-mini',
  // Gemini variants
  'gemini-2-5-flash-preview': 'gemini-2-5-flash',
  'gemini-2-5-pro-preview':   'gemini-2-5-pro',
};

/**
 * Normalize a model name for lookup. Lowercase, replace dots / underscores
 * with dashes, collapse repeated dashes, strip leading/trailing dashes.
 *
 *   "Claude Opus 4.7"          → "claude-opus-4-7"
 *   "claude-opus-4.7"          → "claude-opus-4-7"
 *   "claude_opus_4_7"          → "claude-opus-4-7"
 *   "GPT-4o"                   → "gpt-4o"
 *   "gemini-2.5-pro"           → "gemini-2-5-pro"
 */
export function normalizeModelName(name) {
  if (!name || typeof name !== 'string') return null;
  let n = name.toLowerCase().trim();
  // Replace spaces, dots, underscores with dashes
  n = n.replace(/[\s._]+/g, '-');
  // Collapse repeated dashes, trim
  n = n.replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (!n) return null;
  return n;
}

/**
 * Look up pricing for a model. Returns `{ promptPerMillion, completionPerMillion, cachedPerMillion }`
 * or `null` for unknown models.
 *
 * @param {string} modelName
 * @returns {{ promptPerMillion:number, completionPerMillion:number, cachedPerMillion?:number } | null}
 */
export function getPricing(modelName) {
  const norm = normalizeModelName(modelName);
  if (!norm) return null;
  if (PRICING[norm]) return PRICING[norm];
  if (ALIASES[norm] && PRICING[ALIASES[norm]]) return PRICING[ALIASES[norm]];
  return null;
}

/**
 * Compute the USD cost of a single MGA call.
 *
 * @param {object} args
 * @param {number} [args.promptTokens]
 * @param {number} [args.completionTokens]
 * @param {number} [args.cachedTokens] — counted at the cached rate, not the prompt rate.
 * @param {string} args.model
 * @returns {number | null} USD as a float, rounded to 6 decimal places. `null` if model is unknown.
 */
export function computeCost({ promptTokens = 0, completionTokens = 0, cachedTokens = 0, model } = {}) {
  const pricing = getPricing(model);
  if (!pricing) return null;

  // Cached tokens are a *subset* of prompt-side tokens — providers typically
  // report them separately. To avoid double-billing the cached portion, treat
  // promptTokens as the *non-cached* prompt total. If the caller follows the
  // convention of `promptTokens = total_prompt_tokens` (cached included),
  // they should subtract cachedTokens before passing in. We pick the
  // OpenAI-style "promptTokens = uncached" convention here because MGA's
  // usage block follows that shape.
  const promptUsd = (promptTokens / 1_000_000) * pricing.promptPerMillion;
  const completionUsd = (completionTokens / 1_000_000) * pricing.completionPerMillion;
  const cachedRate = pricing.cachedPerMillion != null ? pricing.cachedPerMillion : pricing.promptPerMillion;
  const cachedUsd = (cachedTokens / 1_000_000) * cachedRate;

  const total = promptUsd + completionUsd + cachedUsd;
  return Math.round(total * 1_000_000) / 1_000_000;
}

// Exported for unit testing / introspection.
export const __test = { PRICING, ALIASES };
