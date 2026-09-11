// Pre-`compose up` host-port conflict check. Catches the common case where
// the user's other dev container (e.g. `dd-template-repo-spike-backend-1`)
// is holding port 3000, so the smoke / dev-build's `compose up -d --build`
// would waste minutes on builds before failing on `Bind for 0.0.0.0:3000
// failed: port is already allocated`.
//
// Detection strategy:
//   1. Parse docker-compose.yml for each service's host-side `ports:`
//   2. Try to bind each port via a transient TCP server. EADDRINUSE → in use.
//   3. Enrich with `docker ps` output so the conflict message names the
//      offending container when applicable. If docker isn't running or the
//      port is held by a non-docker process, the message says "unknown".
//
// Best-effort by design: any throw inside this module returns [] so the
// caller proceeds with compose-up. The point is a fast, useful diagnostic
// when the obvious case happens, not an exhaustive lockdown.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { execSync } from 'node:child_process';
import YAML from 'yaml';
import { PORT_PROBE_MS } from '../config/defaults.js';

function extractHostPorts(composePath) {
  let compose;
  try {
    compose = YAML.parse(readFileSync(composePath, 'utf8'));
  } catch {
    return [];
  }
  const services = compose?.services;
  if (!services || typeof services !== 'object') return [];

  const ports = [];
  for (const [serviceName, service] of Object.entries(services)) {
    const declared = service?.ports;
    if (!Array.isArray(declared)) continue;
    for (const entry of declared) {
      const host = parseHostPort(entry);
      if (Number.isFinite(host)) ports.push({ port: host, service: serviceName });
    }
  }
  return ports;
}

function parseHostPort(entry) {
  // Forms compose accepts:
  //   "8080"                 → host 8080, container 8080
  //   "8080:8080"            → host 8080, container 8080
  //   "127.0.0.1:8080:8080"  → host 8080 on 127.0.0.1
  //   { published: 8080, target: 8080 }
  //   { published: "8080", target: 8080 }
  if (typeof entry === 'string') {
    const parts = entry.split(':');
    const candidate = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
    return parseInt(candidate, 10);
  }
  if (entry && typeof entry === 'object' && entry.published != null) {
    return parseInt(entry.published, 10);
  }
  return NaN;
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', (err) => {
      resolve(err.code !== 'EADDRINUSE' && err.code !== 'EACCES');
    });
    srv.once('listening', () => {
      srv.close(() => resolve(true));
    });
    try {
      srv.listen(port, '0.0.0.0');
    } catch {
      resolve(true); // ambiguous → assume free, let compose try
    }
  });
}

function lookupDockerHolder(port) {
  let rows;
  try {
    const out = execSync('docker ps --format "{{.Names}}\t{{.Ports}}"', {
      stdio: 'pipe',
      timeout: PORT_PROBE_MS,
    }).toString();
    rows = out.split('\n').filter(Boolean).map((l) => {
      const tab = l.indexOf('\t');
      return tab < 0 ? { name: l, portStr: '' } : { name: l.slice(0, tab), portStr: l.slice(tab + 1) };
    });
  } catch {
    return null;
  }
  // Match strings like `0.0.0.0:3000->3000/tcp` or `[::]:3000->3000/tcp`
  const re = new RegExp(`(?:^|,\\s|\\s)(?:[\\d.:]+:)?${port}->`);
  const hit = rows.find((r) => re.test(r.portStr));
  return hit ? hit.name : null;
}

export async function detectPortConflicts(workspaceDir) {
  const composePath = path.join(workspaceDir, 'docker-compose.yml');
  if (!existsSync(composePath)) return [];

  const needed = extractHostPorts(composePath);
  if (!needed.length) return [];

  const conflicts = [];
  const seen = new Set();
  for (const { port, service } of needed) {
    if (seen.has(port)) continue;
    seen.add(port);

    const free = await isPortFree(port);
    if (free) continue;

    conflicts.push({
      port,
      service,
      holder: lookupDockerHolder(port),
    });
  }
  return conflicts;
}
