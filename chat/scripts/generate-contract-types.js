#!/usr/bin/env node
/**
 * Standalone CLI for W1.TYPES.GEN — regenerate contract types from a
 * given workspace's `.harness/contracts.json`. Same generator as the
 * one wired into `write_harness_state`; this entrypoint is for:
 *
 *   - Manual regeneration after hand-editing `.harness/contracts.json`.
 *   - Bootstrapping types into an existing workspace before the agent
 *     touches it (CI / preflight).
 *   - Smoke verification (run the generator on a fixture, diff the output).
 *
 * Usage:
 *   node chat/scripts/generate-contract-types.js <workspaceDir>
 *
 * Flags:
 *   --skip-self-test   Skip the `tsc --noEmit` pass. Useful when running on
 *                      a host without typescript installed; the generator
 *                      otherwise tries (in order) workspace/{frontend,backend}/
 *                      node_modules/.bin/tsc, then PATH, then `npx -y typescript`.
 *
 * Exit codes:
 *   0 — wrote at least one file OR cleanly skipped (no scopes to emit).
 *   1 — validation error / write error / any path produced an error.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateContractTypes } from '../server/agent/contract-types-generator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseArgs(argv) {
  const args = { workspaceDir: null, skipSelfTest: false };
  for (const a of argv) {
    if (a === '--skip-self-test') args.skipSelfTest = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (!args.workspaceDir && !a.startsWith('--')) args.workspaceDir = a;
  }
  return args;
}

function printHelp() {
  process.stdout.write(
    'Usage: node chat/scripts/generate-contract-types.js <workspaceDir> [--skip-self-test]\n' +
    '\n' +
    'Reads <workspaceDir>/.harness/contracts.json and emits TS / Pydantic\n' +
    'into <workspaceDir>/{backend,frontend}/.../generated/.\n'
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.workspaceDir) {
    printHelp();
    process.exit(args.help ? 0 : 1);
  }
  const workspaceDir = path.resolve(args.workspaceDir);
  if (!existsSync(workspaceDir)) {
    process.stderr.write(`ERROR: workspace directory not found: ${workspaceDir}\n`);
    process.exit(1);
  }

  const result = generateContractTypes(workspaceDir, { skipSelfTest: args.skipSelfTest });

  const out = [];
  out.push(`# Contract types generator — ${new Date().toISOString()}`);
  out.push('');
  out.push(`Workspace: ${workspaceDir}`);
  out.push('');
  if (result.written.length > 0) {
    out.push('## Files written');
    out.push('');
    for (const f of result.written) out.push(`- ${path.relative(workspaceDir, f)}`);
    out.push('');
  }
  if (result.skipped.length > 0) {
    out.push('## Skipped');
    out.push('');
    for (const s of result.skipped) out.push(`- ${s}`);
    out.push('');
  }
  if (result.errors.length > 0) {
    out.push('## Errors / Warnings');
    out.push('');
    for (const e of result.errors) out.push(`- ${e}`);
    out.push('');
  }
  process.stdout.write(out.join('\n'));

  // Exit 1 if anything errored (validation, write, schema). Warnings about
  // unknown SQL types are captured in `errors[]` so a CI invocation can
  // surface them as test failures — the generator itself still writes the
  // file with `unknown` / `Any` fallbacks.
  process.exit(result.errors.length > 0 ? 1 : 0);
}

main();
