// image-blocks.js — build OpenAI-style vision image blocks from session uploads.
//
// Shared by the post-build concierge AND the initial planner (Understanding
// Agent) so both can let the model actually SEE uploaded images — UI mockups,
// screenshots, architecture diagrams — instead of only their filename/metadata.
// Reading them as base64 image blocks is the only way the model gets the visual.
//
// FORMAT: MGA's /chat/completions proxy is OpenAI-compatible. It ACCEPTS
// multimodal array content for user messages as long as image blocks use the
// OpenAI `image_url` shape ({ type:'image_url', image_url:{ url:'data:…' } }).
// It REJECTS Anthropic-style blocks ({ type:'image', source:{…} }) with a 422
// ("Input should be a valid string"). Verified live against gpt-4o and
// claude-sonnet-4.5 — both read a base64 data-URL mockup natively, so we embed
// the image into the agent's own (vision-capable) call; no describe-to-text hop.

import fs from 'node:fs';
import path from 'node:path';
import { tlog } from '../../util/timestamped-log.js';
import { logSafe } from '../../util/log-helpers.js';

// Vision accepts png/jpeg/gif/webp; it does NOT accept SVG.
export function isVisionImage(mime) {
  return typeof mime === 'string' && mime.startsWith('image/') && mime !== 'image/svg+xml';
}

/**
 * Read each image upload off disk and return OpenAI `image_url` content blocks.
 * Non-images and unreadable files are skipped (best-effort — a missing image
 * must never break the request). Images are sent as base64 `data:` URLs at
 * `detail: 'high'` so the model can read small UI text (labels, numbers).
 *
 * @param {Array} uploads — session upload records ({ mime, relativePath, filename })
 * @param {string} workspaceDir — base dir the relativePath is resolved against
 * @param {string} [logTag] — label for skip-warnings
 * @returns {Array} [{ type:'image_url', image_url:{ url:'data:<mime>;base64,<data>', detail:'high' } }, …]
 */
export function buildImageBlocks(uploads, workspaceDir, logTag = 'image-blocks') {
  const safe = Array.isArray(uploads) ? uploads : [];
  const blocks = [];
  for (const u of safe) {
    if (!isVisionImage(u?.mime)) continue;
    try {
      const bytes = fs.readFileSync(path.join(workspaceDir, u.relativePath));
      blocks.push({
        type: 'image_url',
        image_url: { url: `data:${u.mime};base64,${bytes.toString('base64')}`, detail: 'high' },
      });
    } catch (err) {
      tlog('[%s] failed to read image upload %s (%s): %s — skipping',
        logTag, logSafe(u?.filename), logSafe(u?.relativePath), logSafe(err.message));
    }
  }
  return blocks;
}
