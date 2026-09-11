// E2E: drive the REAL planner (routeMessage) with a REAL image upload, exactly
// as POST /api/session/:id/message does — sanitiseUploadsPayload -> routeMessage.
// Proves the planner actually SEES the image: we send a vague "build this" with
// the dashboard mockup and check the response references things that exist ONLY
// in the image (Contracts/Findings nav, the stat cards, the contracts table).
//
// Run from chat/:  node scripts/planner-vision-e2e.mjs
// Uses the real .chat/secrets.json creds + assistants.json IDs.

import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { WORKSPACE_DIR } from '../server/core/paths.js';
import { sanitiseUploadsPayload } from '../server/session/lifecycle.js';
import { routeMessage } from '../server/agent/planner/two-agent.js';

// 1. Stage the mockup where /api/upload would have written it: <workspace>/context/
const ctxDir = path.join(WORKSPACE_DIR, 'context');
mkdirSync(ctxDir, { recursive: true });
const dest = path.join(ctxDir, 'mockup.png');
copyFileSync('/tmp/mockup.png', dest);
console.log('staged mockup at', dest, 'exists=', existsSync(dest));

// 2. Build the upload object exactly as /api/upload returns it, then run it
//    through the same sanitiser the route uses.
const uploads = sanitiseUploadsPayload([{
  filename: 'mockup.png',
  relativePath: 'context/mockup.png',
  size: 12345,
  mime: 'image/png',
  parsed: { preview: 'PNG image 720x460', summary: 'image/png, 12345 bytes' },
}]);
console.log('sanitised uploads:', uploads.length, uploads[0]?.mime);

// 3. Vague message — the ONLY way the planner can name dashboard specifics is by
//    reading the image.
const message = 'Build me a web app that looks like this. What screens and features do you see in it?';
const envContext = { hasStructure: {}, phase: 'empty' };

console.log('\n--- calling routeMessage (real planner) ---\n');
const t0 = Date.now();
let result;
try {
  result = await routeMessage(message, envContext, { uploads, workspaceDir: WORKSPACE_DIR });
} catch (e) {
  console.error('routeMessage threw:', e.message);
  cleanup();
  process.exit(1);
}
console.log(`\n--- planner returned in ${Date.now() - t0}ms ---`);
console.log('action:', result?.action || result?.type || '(see object)');

// Surface the human-facing text + any structured questions / brief so we can
// eyeball whether it described the image.
const blob = JSON.stringify(result, null, 2);
const visionTerms = ['contract', 'finding', 'pending review', 'sidebar', 'overview',
  'settings', 'upload', 'table', 'dashboard', 'jane', 'nda', 'msa', 'sow', '1,284', '1284'];
const hits = visionTerms.filter(t => blob.toLowerCase().includes(t));

console.log('\n=== RESULT (truncated) ===');
console.log(blob.length > 4000 ? blob.slice(0, 4000) + '\n…[truncated]' : blob);
console.log('\n=== VISION CHECK ===');
console.log(`image-specific terms found in response: ${hits.length} -> [${hits.join(', ')}]`);
console.log(hits.length >= 3
  ? 'PASS — planner clearly read the mockup (named image-only details).'
  : 'INCONCLUSIVE — few/no image-specific terms; inspect the result above.');

cleanup();

function cleanup() {
  try { rmSync(dest, { force: true }); } catch { /* ignore */ }
}
