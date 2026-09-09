/**
 * port-offset.js — shift every host port in the workspace docker-compose.yml
 * by (offset * 10) so parallel harness runs (smoke slots, a bench next to
 * another project) don't collide on 8080/3000/5432. Idempotent: mappings
 * this module already produced are recorded in .harness/port-offset.json
 * and skipped on the next call, so an iterate (compose file kept, auto-start
 * re-run) doesn't shift 9080 → 10080. A compose file the integration agent
 * rewrote with fresh 8080 mappings is shifted again, because those mappings
 * aren't in the record.
 *
 * Conservative regex-based rewrite (no YAML parser) — handles the common
 * compose port-mapping forms the integration agent emits:
 *   - "8080:8080"          — quoted
 *   - 8080:8080            — bare
 *   - "8080:8080/tcp"      — with protocol
 * Does NOT touch bare `8080` (container-port-only, no host bind) or
 * `127.0.0.1:8080:8080` (explicit bind IP — rare in our flows).
 *
 * @returns {Array<{from: string, to: string}>|null} remappings applied, null if nothing changed
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const MARKER = path.join('.harness', 'port-offset.json');

function readMarker(workspaceDir) {
  try {
    const m = JSON.parse(readFileSync(path.join(workspaceDir, MARKER), 'utf-8'));
    return { offset: Number(m.offset) || 0, applied: new Set(Array.isArray(m.applied) ? m.applied : []) };
  } catch {
    return { offset: 0, applied: new Set() };
  }
}

export function applyPortOffsetToCompose(workspaceDir, offset) {
  if (!offset || offset <= 0) return null;
  const composePath = path.join(workspaceDir, 'docker-compose.yml');
  if (!existsSync(composePath)) return null;
  const marker = readMarker(workspaceDir);
  const already = marker.offset === offset ? marker.applied : new Set();
  const text = readFileSync(composePath, 'utf-8');
  const lines = text.split('\n');
  const out = [];
  const remappings = [];
  let inPortsBlock = false;
  let portsIndent = -1;
  for (const line of lines) {
    const lineIndent = (line.match(/^(\s*)/) || ['', ''])[1].length;
    if (inPortsBlock) {
      // Block ends when we hit a blank line or pop back to ≤ ports' indent.
      if (line.trim() === '' || lineIndent <= portsIndent) {
        inPortsBlock = false;
        // Fall through to the regular line-handling below (which may also
        // detect a new `ports:` opener on this line).
      } else {
        // Inside the ports block — rewrite the first <host>:<container> on the line.
        const replaced = line.replace(
          /(["']?)(\d+):(\d+)(\/[a-z]+)?(["']?)/,
          (m, q1, host, ctr, proto, q2) => {
            if (already.has(`${host}:${ctr}`)) return m;
            const newHost = parseInt(host, 10) + offset * 10;
            remappings.push({ from: `${host}:${ctr}`, to: `${newHost}:${ctr}` });
            return `${q1}${newHost}:${ctr}${proto || ''}${q2}`;
          },
        );
        out.push(replaced);
        continue;
      }
    }
    const portsMatch = line.match(/^(\s*)ports:\s*$/);
    if (portsMatch) {
      inPortsBlock = true;
      portsIndent = portsMatch[1].length;
    }
    out.push(line);
  }
  if (remappings.length === 0) return null;
  writeFileSync(composePath, out.join('\n'), 'utf-8');
  try {
    mkdirSync(path.join(workspaceDir, '.harness'), { recursive: true });
    writeFileSync(path.join(workspaceDir, MARKER), JSON.stringify({
      offset,
      applied: [...new Set([...already, ...remappings.map((r) => r.to)])],
    }, null, 2));
  } catch { /* marker is best-effort; worst case the next call shifts again */ }
  return remappings;
}
