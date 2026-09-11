/**
 * Disk-sourced prompt loader + composer.
 *
 * Loads instructions for /chat/completions-mode agents directly from
 * chat/prompts/*.md in this repo. The MGA assistant_id is still consulted
 * via getAssistantConfig for model selection (so each agent's model stays
 * centrally pinned) — only the instructions move to disk.
 *
 * Two surfaces:
 *
 *   loadPrompt(filename, {strip=true})
 *     Single-file load. Used for prompts that aren't composed
 *     (concierge, understanding-agent, contract-agent, summarizer,
 *     investigator, etc.). Strips YAML frontmatter / prose preamble by
 *     default so the runtime text matches what the upload script PATCHes
 *     into MGA. Pass {strip:false} for canonical snippets / platform
 *     constraints that must be inlined verbatim.
 *
 *   composeAssistantPrompt(name)
 *     Recipe-driven load. Looks up `name` in the assistants manifest
 *     (manifest.js) and assembles per the same composition the upload
 *     script uses: base + inline rules + canonical scaffold + platform
 *     constraints + overlay. Used for subagent prompts whose final text
 *     is glued from multiple source files. The upload script imports
 *     this same composer so the runtime and MGA-stored copies stay
 *     byte-for-byte equivalent.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSISTANTS } from './manifest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// chat/server/agent/prompts/ → ../../../../ = spike root.
export const SPIKE_ROOT = path.resolve(__dirname, '../../../..');
// chat/server/agent/prompts/ → ../../../prompts/
export const PROMPTS_DIR = path.resolve(__dirname, '../../../prompts');

/**
 * Strip the human-only preamble from a prompt source file.
 *
 * Two formats supported (mirrors the logic in
 * chat/scripts/upload-assistant-prompt.js so runtime + upload produce
 * the same bytes):
 *
 *   1. YAML frontmatter — file starts with `---` on line 1, has a closing
 *      `---` a few lines down. Strip everything up to and including the
 *      closing `---`.
 *   2. Preamble-then-separator — file starts with prose, has a single
 *      `---` line later. Strip everything up to and including it.
 *
 * No `---` found → return as-is (treat the whole file as prompt content).
 */
export function stripPreamble(text) {
  const lines = text.split('\n');
  if (lines.length === 0) return text;

  // Format 1: YAML frontmatter — first non-empty line is `---`.
  let firstContentLine = 0;
  while (firstContentLine < lines.length && lines[firstContentLine].trim() === '') firstContentLine++;
  if (firstContentLine < lines.length && lines[firstContentLine].trim() === '---') {
    for (let i = firstContentLine + 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') {
        return lines.slice(i + 1).join('\n').replace(/^\n+/, '').trimEnd() + '\n';
      }
    }
    return text; // opening but no closing — treat as content
  }

  // Format 2: prose preamble followed by `---` separator.
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      return lines.slice(i + 1).join('\n').replace(/^\n+/, '').trimEnd() + '\n';
    }
  }

  return text;
}

/**
 * Read a prompt file from chat/prompts/. Strips frontmatter by default
 * (matches what upload-assistant-prompt.js PATCHes to MGA).
 *
 * Throws on missing/unreadable file — caller surfaces as a configuration
 * failure. No caching: chat/prompts/*.md is edited live during dev and
 * read cost is negligible (small markdown, OS file cache).
 *
 * @param {string} filename - e.g. 'concierge.md'
 * @param {{strip?: boolean}} [opts]
 * @returns {string}
 */
export function loadPrompt(filename, { strip = true } = {}) {
  const file = path.join(PROMPTS_DIR, filename);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    throw new Error(`prompts: could not read ${file}: ${err.message}`);
  }
  return strip ? stripPreamble(raw) : raw;
}

/**
 * Read an arbitrary file from SPIKE_ROOT (for inline rules, canonical
 * snippets, platform constraints — all referenced by paths relative to
 * the repo root in the assistant manifest).
 *
 * @param {string} relPath - e.g. '.platform-rules/global.md'
 * @param {{strip?: boolean}} [opts]
 */
function loadFromSpikeRoot(relPath, { strip = false } = {}) {
  const file = path.join(SPIKE_ROOT, relPath);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    throw new Error(`prompts: could not read ${file}: ${err.message}`);
  }
  return strip ? stripPreamble(raw) : raw;
}

/**
 * Compose the full system-prompt text for an assistant per the manifest
 * recipe. Mirrors chat/scripts/upload-assistant-prompt.js byte-for-byte
 * so runtime + MGA stored copy stay equivalent.
 *
 * Composition layout (Phase agent / subagent prompts):
 *   <subagent-base.md, preamble stripped, trimEnd>
 *   \n\n
 *   === BASELINE PLATFORM RULES (always apply) ===
 *   \n\n
 *   <each inlineRule: "<!-- inline: <rel> -->\n<stripped+trimEnd content>"
 *    joined by "\n\n">
 *   \n\n
 *   === CANONICAL SCAFFOLD ===
 *   \n\n
 *   <each snippet: "Path: <rel>\n\n```\n<raw+trimEnd>\n```" joined by "\n\n">
 *   \n\n
 *   === PLATFORM CONSTRAINTS ===
 *   \n\n
 *   <each constraint: "Path: <rel>\n\n<raw+trimEnd>" joined by "\n\n">
 *   \n\n
 *   <overlay (src), preamble stripped>
 *
 * Each optional section is skipped when the manifest entry doesn't
 * configure it. When ONLY the overlay is present (no base/rules/snippets/
 * constraints), the result IS the overlay (no joining) — matches the
 * upload script's "composeParts.length > 1" branch.
 *
 * @param {string} name - assistant key in the manifest
 * @returns {string}
 */
export function composeAssistantPrompt(name) {
  const cfg = ASSISTANTS[name];
  if (!cfg) {
    throw new Error(`composeAssistantPrompt: unknown assistant "${name}". `
      + `Valid: ${Object.keys(ASSISTANTS).join(', ')}`);
  }

  const overlayText = loadFromSpikeRoot(cfg.src, { strip: true });
  const parts = [];

  if (cfg.base) {
    parts.push(loadFromSpikeRoot(cfg.base, { strip: true }).trimEnd());
  }

  if (Array.isArray(cfg.inlineRules) && cfg.inlineRules.length > 0) {
    const blocks = cfg.inlineRules.map((rel) => {
      const text = loadFromSpikeRoot(rel, { strip: true });
      return `<!-- inline: ${rel} -->\n${text.trimEnd()}`;
    });
    parts.push('=== BASELINE PLATFORM RULES (always apply) ===\n\n' + blocks.join('\n\n'));
  }

  if (cfg.inlineCanonicalSnippet) {
    const paths = Array.isArray(cfg.inlineCanonicalSnippet)
      ? cfg.inlineCanonicalSnippet
      : [cfg.inlineCanonicalSnippet];
    const blocks = paths.map((rel) => {
      const text = loadFromSpikeRoot(rel, { strip: false });
      return `Path: ${rel}\n\n` + '```\n' + text.trimEnd() + '\n```';
    });
    parts.push('=== CANONICAL SCAFFOLD ===\n\n' + blocks.join('\n\n'));
  }

  if (cfg.inlinePlatformConstraints) {
    const paths = Array.isArray(cfg.inlinePlatformConstraints)
      ? cfg.inlinePlatformConstraints
      : [cfg.inlinePlatformConstraints];
    const blocks = paths.map((rel) => {
      const text = loadFromSpikeRoot(rel, { strip: false });
      return `Path: ${rel}\n\n` + text.trimEnd();
    });
    parts.push('=== PLATFORM CONSTRAINTS ===\n\n' + blocks.join('\n\n'));
  }

  parts.push(overlayText);

  return parts.length > 1 ? parts.join('\n\n') : overlayText;
}
