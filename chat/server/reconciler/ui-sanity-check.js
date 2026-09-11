/**
 * ui-sanity-check.js — post-compose visual verification of the primary view.
 *
 * The endpoint probe proves handlers respond; it cannot see rendering
 * defects (an ingredients list of "[object Object]" is an HTTP 200).
 * This check screenshots the running app with headless Chrome and asks an
 * MGA vision model one narrow question: would a user immediately see
 * something broken on the primary view?
 *
 * Report-only by design (v1): visual judgments are fuzzier than HTTP
 * status codes, so defects surface as a chat message for the user to act
 * on — no automatic fix dispatch, no build blocking.
 *
 * Requires a Chrome/Chromium binary (CHROME_BIN env or a known location).
 * Absent browser, absent uiContract, or UI_SANITY_SKIP=true → skipped
 * silently. Every failure path degrades to "skipped", never an error.
 */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { callMgaCompletions } from '../agent/llm/llm.js';
import { pickModel } from '../agent/llm/model-picker.js';
import { tlog } from '../util/timestamped-log.js';

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
];

const SCREENSHOT_TIMEOUT_MS = 30_000;

const JUDGE_SYSTEM_PROMPT = `You are a UI sanity judge for freshly generated web applications. You receive a screenshot of the app's primary view plus what the view is supposed to show. Report ONLY defects a user would immediately see:

- rendering artifacts: "[object Object]", "undefined", "NaN", "null", unrendered template syntax
- a blank/white page or raw error text (stack traces, "Cannot GET", JSON error dumps)
- the primary view or primary action missing entirely
- severely broken layout (overlapping/unreadable content)

Do NOT flag: styling taste, empty data states with helpful hints, placeholder text in inputs, or anything requiring interaction to observe.

Output ONLY valid JSON — no markdown, no preamble:
{
  "sane": boolean,
  "defects": [{ "severity": "high" | "medium", "description": "string — what is visibly wrong and where" }]
}
Empty defects array and sane=true when the view looks like a working app.`;

export function findChromeBinary() {
  if (process.env.CHROME_BIN && existsSync(process.env.CHROME_BIN)) return process.env.CHROME_BIN;
  return CHROME_CANDIDATES.find((p) => existsSync(p)) || null;
}

/** Capture `url` to a PNG. Resolves the path, or null on any failure. */
export function captureScreenshot(chromeBin, url, outPath) {
  return new Promise((resolve) => {
    execFile(chromeBin, [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--hide-scrollbars',
      '--window-size=1280,900',
      // Let the SPA render: virtual time fast-forwards timers/network idle.
      '--virtual-time-budget=10000',
      `--screenshot=${outPath}`,
      url,
    ], { timeout: SCREENSHOT_TIMEOUT_MS }, (err) => {
      if (err || !existsSync(outPath)) {
        tlog('[ui-sanity] screenshot failed: %s', err?.message || 'no output file');
        resolve(null);
        return;
      }
      resolve(outPath);
    });
  });
}

/** Tolerant JSON extraction — models occasionally fence their output. */
export function parseVerdict(content) {
  if (typeof content !== 'string') return null;
  const raw = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  try {
    const v = JSON.parse(raw);
    if (typeof v?.sane !== 'boolean') return null;
    return {
      sane: v.sane,
      defects: (Array.isArray(v.defects) ? v.defects : [])
        .filter((d) => d && typeof d.description === 'string')
        .map((d) => ({ severity: d.severity === 'high' ? 'high' : 'medium', description: d.description.slice(0, 300) })),
    };
  } catch {
    return null;
  }
}

/**
 * @param {object} opts
 * @param {string}   opts.url        - frontend origin (http://localhost:8080)
 * @param {object}   opts.uiContract - contract's ui_contract (primary_view/primary_action/components)
 * @param {function} [opts.captureImpl] - test seam; defaults to captureScreenshot
 * @returns {Promise<{ skipped?: string, sane?: boolean, defects?: Array, durationMs?: number }>}
 */
export async function runUiSanityCheck({ url, uiContract, captureImpl = null } = {}) {
  if (process.env.UI_SANITY_SKIP === 'true') return { skipped: 'env' };
  if (!uiContract || typeof uiContract.primary_view !== 'string') return { skipped: 'no-ui-contract' };

  const chromeBin = findChromeBinary();
  if (!chromeBin && !captureImpl) return { skipped: 'no-browser' };

  const started = Date.now();
  const outPath = path.join(os.tmpdir(), `ui-sanity-${process.pid}-${started}.png`);
  const capture = captureImpl || ((u, o) => captureScreenshot(chromeBin, u, o));
  const shot = await capture(url, outPath);
  if (!shot) return { skipped: 'screenshot-failed' };

  let verdict = null;
  try {
    const bytes = readFileSync(shot);
    const componentNames = (uiContract.components || [])
      .map((c) => c?.name)
      .filter(Boolean)
      .slice(0, 12);
    const expectation = [
      `Primary view: ${uiContract.primary_view}`,
      `Primary action: ${uiContract.primary_action || '(unspecified)'}`,
      componentNames.length ? `Expected components: ${componentNames.join(', ')}` : null,
      'The app was just generated and its database is empty — empty lists with helpful hints are fine.',
    ].filter(Boolean).join('\n');

    const { model } = pickModel({ phase: 'CONTRACT' });
    const { content } = await callMgaCompletions({
      messages: [
        { role: 'system', content: JUDGE_SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: expectation },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${bytes.toString('base64')}`, detail: 'high' } },
          ],
        },
      ],
      model,
      assistantLabel: 'ui-sanity-judge',
      phase: 'CONTRACT',
    });
    verdict = parseVerdict(content);
  } catch (err) {
    tlog('[ui-sanity] judge call failed: %s', err?.message || err);
  } finally {
    try { unlinkSync(shot); } catch { /* tmp file — best effort */ }
  }

  if (!verdict) return { skipped: 'judge-unparseable' };
  tlog('[ui-sanity] verdict: sane=%s defects=%d (%dms)', verdict.sane, verdict.defects.length, Date.now() - started);
  return { sane: verdict.sane, defects: verdict.defects, durationMs: Date.now() - started };
}
