/**
 * Test workspace isolation helper.
 *
 * Allocates an isolated temp directory + non-colliding port range + Docker
 * container prefix per test. Required for parallel-safe integration tests:
 * without isolation, two tests fight over `.harness/` dirs, MGA
 * `conversation_id`s would alias (not addressed here — that's the mock
 * layer's job), and Docker compose project names would collide.
 *
 * Contract:
 *   const ws = await createTestWorkspace({ scope: 'mga-mock', scenarioName: 'iterate' });
 *   try {
 *     // ws.dir          — absolute path under os.tmpdir()
 *     // ws.ports        — { backend, frontend, database, vectordb } numbers
 *     // ws.containerPrefix — `test-<uuid>-` for `docker compose -p <prefix>`
 *     // ws.uuid         — the raw uuid used to key the workspace
 *   } finally {
 *     await ws.cleanup(); // best-effort rmdir + docker rm of containers matching prefix
 *   }
 *
 * Design notes:
 *   - UUID-keyed dir prevents collisions between parallel test runs.
 *   - Port range comes from a process-local monotonic counter, so two
 *     workspaces in the same test process always get distinct ranges. The
 *     SLOTS ceiling (1024) caps how many workspaces a single test process
 *     can allocate before throwing — far above any realistic use. Tests
 *     don't actually bind the ports here — the helper just hands out a
 *     non-overlapping range each test can use for its own Docker compose
 *     / supertest stubs.
 *   - cleanup() is best-effort and idempotent: calling twice doesn't throw,
 *     and a docker absence (no daemon, no matching containers) is swallowed
 *     per L.5 (logAndSwallow style — we don't import logAndSwallow because
 *     the helper is intentionally test-tier-local with zero harness imports).
 */

import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

// Port allocation: monotonic per-process counter. Each createTestWorkspace
// call gets the next slot from a process-local counter — collision-free up
// to SLOTS workspaces per test process.
//
// Previous implementation hashed the uuid into SLOTS=1024 buckets. With 10
// concurrent workspaces in one test the birthday-paradox collision rate was
// ~4.3% (10*9/2/1024), making the "10 distinct port ranges" assertion
// intermittently flake. The hash bought us nothing — these workspaces are
// torn down at end-of-test, so cross-process determinism wasn't needed.
const PORT_BASE = 20000;
const SLOT_SIZE = 16;     // backend, frontend, database, vectordb + headroom
const SLOTS = 1024;       // 20000..36384 — well clear of common dev ports

const _slotByUuid = new Map();
let _nextSlot = 0;

function allocateSlot(uuid) {
  if (_slotByUuid.has(uuid)) return _slotByUuid.get(uuid);
  if (_nextSlot >= SLOTS) {
    throw new Error(`test-workspace: exhausted ${SLOTS} port slots in this process — raise SLOTS`);
  }
  const slot = _nextSlot++;
  _slotByUuid.set(uuid, slot);
  return slot;
}

function portsForUuid(uuid) {
  const slot = allocateSlot(uuid);
  const base = PORT_BASE + slot * SLOT_SIZE;
  return {
    backend: base + 0,
    frontend: base + 1,
    database: base + 2,
    vectordb: base + 3,
  };
}

// Best-effort docker rm. Resolves to { removed: number } or { removed: 0 }
// when docker is unavailable or no containers match. Never throws.
async function dockerCleanup(containerPrefix, { timeoutMs = 3_000 } = {}) {
  return new Promise((resolve) => {
    // `docker ps -aq --filter "name=<prefix>"` is the only call that lists
    // containers by name prefix without requiring compose project knowledge.
    const ps = spawn('docker', ['ps', '-aq', '--filter', `name=${containerPrefix}`], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    // A degraded daemon can leave `docker ps -a` hanging indefinitely
    // (observed 2026-09-10: every workspace-using test file froze the whole
    // suite). Cleanup is best-effort — give up rather than hang.
    const timer = setTimeout(() => { try { ps.kill('SIGKILL'); } catch { /* gone */ } resolve({ removed: 0 }); }, timeoutMs);
    let stdout = '';
    ps.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    ps.on('error', () => { clearTimeout(timer); resolve({ removed: 0 }); }); // docker not installed
    ps.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve({ removed: 0 });
      const ids = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
      if (ids.length === 0) return resolve({ removed: 0 });
      const rm = spawn('docker', ['rm', '-f', ...ids], { stdio: 'ignore' });
      rm.on('error', () => resolve({ removed: 0 }));
      rm.on('close', () => resolve({ removed: ids.length }));
    });
  });
}

/**
 * Create an isolated workspace.
 *
 * @param {object} [opts]
 * @param {string} [opts.scope] — informational tag for dir name (e.g. 'mga-mock')
 * @param {string} [opts.scenarioName] — informational tag for dir name (e.g. 'iterate-cosmetic')
 * @returns {Promise<{
 *   dir: string,
 *   uuid: string,
 *   ports: { backend: number, frontend: number, database: number, vectordb: number },
 *   containerPrefix: string,
 *   cleanup: () => Promise<void>,
 * }>}
 */
export async function createTestWorkspace({ scope, scenarioName } = {}) {
  const uuid = randomUUID();
  const tagParts = [scope, scenarioName].filter(Boolean).join('-') || 'test';
  // Sanitize: tagParts can contain anything; force to [a-z0-9-] for dir + docker.
  const tag = tagParts.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40) || 'test';
  const prefix = join(tmpdir(), `harness-test-${process.pid}-${tag}-`);
  // mkdtemp appends a 6-char suffix; we additionally include the full uuid
  // in the trailing path component so two parallel calls with the same tag
  // can never collide even on systems with low-entropy mkdtemp.
  const dir = await mkdtemp(prefix);
  // We don't rename the dir post-creation (race risk); the uuid lives on
  // the returned object instead. The dir name still gives operators a
  // glanceable hint via the tag.

  const ports = portsForUuid(uuid);
  const containerPrefix = `test-${uuid.slice(0, 12)}-`;

  let cleaned = false;
  async function cleanup() {
    if (cleaned) return; // idempotent
    cleaned = true;
    // Best-effort: rmdir + docker rm. Failures swallowed.
    try {
      await rm(dir, { recursive: true, force: true });
    } catch (err) {
      // Swallow — test cleanup shouldn't surface filesystem hiccups.
      // Operator can `find /tmp -name 'harness-test-*' -mtime +1` to GC manually.
      // eslint-disable-next-line no-console
      console.warn(`[test-workspace] cleanup rmdir failed for ${dir}: ${err?.message || err}`);
    }
    await dockerCleanup(containerPrefix); // never throws
  }

  return { dir, uuid, ports, containerPrefix, cleanup };
}
