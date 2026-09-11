// Pre-`compose up` sanitizer that strips `container_name:` lines from
// docker-compose.yml. Catches the bug class:
//
//   services:
//     backend:
//       container_name: backend     # ← phase agent invented this
//
// `container_name:` overrides docker-compose's default project-prefixed
// naming, making the container name GLOBAL to the docker daemon. Two compose
// projects (e.g., two smoke scenarios) using the same fixed name collide:
// "container name backend already in use." Observed t31 in the 2026-05-05
// gate at parallel=1 — t11/t30 left a container named `backend`, t31's
// integration agent ALSO used `container_name: backend`, compose up failed
// fast (4464ms) with a name conflict.
//
// None of the canonical compose snippets (snippets/integration/*.yml) use
// `container_name:` — the integration agent invented it. This sanitizer is
// the runtime guard that closes the class deterministically (per session-5
// "in-code safety nets are NOT optional for prompt-side rules" lesson; the
// prompt-side rule will land alongside this).
//
// Strategy: line-based strip. We don't need YAML AST manipulation — every
// `container_name:` is a one-line scalar at indented level 4 (under each
// service block). Match by indented prefix + key, drop the line.

import fs from 'node:fs';
import path from 'node:path';

const CONTAINER_NAME_LINE = /^\s+container_name\s*:\s*\S+\s*$/m;

/**
 * Scan a workspace's docker-compose.yml for `container_name:` overrides.
 * Returns `{ count, lines }` where `lines` is the array of offending line
 * numbers (1-indexed). Returns `{ count: 0, lines: [] }` when no compose
 * file exists or no overrides found.
 */
export function scanComposeContainerNames(workspaceDir) {
  const composePath = path.join(workspaceDir, 'docker-compose.yml');
  if (!fs.existsSync(composePath)) return { count: 0, lines: [] };

  let content;
  try {
    content = fs.readFileSync(composePath, 'utf-8');
  } catch {
    return { count: 0, lines: [] };
  }

  const lines = content.split('\n');
  const offending = [];
  for (let i = 0; i < lines.length; i++) {
    if (CONTAINER_NAME_LINE.test(lines[i])) {
      offending.push(i + 1);
    }
  }
  return { count: offending.length, lines: offending };
}

/**
 * Strip every `container_name:` line from docker-compose.yml. Returns the
 * number of lines removed. Idempotent — running twice on a clean file
 * returns 0 the second time. Mutates the file in place.
 */
export function stripContainerNames(workspaceDir) {
  const composePath = path.join(workspaceDir, 'docker-compose.yml');

  let content;
  try {
    content = fs.readFileSync(composePath, 'utf-8');
  } catch {
    return 0;
  }

  const inputLines = content.split('\n');
  const outputLines = inputLines.filter((line) => !CONTAINER_NAME_LINE.test(line));
  const removed = inputLines.length - outputLines.length;
  if (removed === 0) return 0;

  try {
    fs.writeFileSync(composePath, outputLines.join('\n'), 'utf-8');
  } catch {
    return 0;
  }
  return removed;
}
