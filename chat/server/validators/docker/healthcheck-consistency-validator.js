// Pre-`compose up` static scan + auto-fix for the bug class:
// a service is referenced by another service's `depends_on:
// condition: service_healthy`, but the referenced service has no
// `healthcheck:` block. `compose build` returns 0 — depends_on isn't
// validated at build — but `compose up` then waits indefinitely for
// the dependency to become "healthy". Docker eventually times out (~60s
// in the daemon's internal health-wait), `compose up -d` returns
// ok=false even though the service has actually started.
//
// This is the t39-time-off-full-stack failure class:
// the integration scope's compose had `frontend: depends_on: backend:
// condition: service_healthy` plus `backend: depends_on: database:
// condition: service_healthy` — and at runtime the backend healthcheck
// (curl on node:20-alpine) was stripped by directive-validator, leaving
// frontend waiting on a service that no longer reported healthy.
// directive-validator already downgrades dependents when IT strips a
// healthcheck, but it doesn't catch the case where the healthcheck was
// never written in the first place. This validator fills that gap.
//
// Strategy: for each service referenced via `depends_on: ...:
// condition: service_healthy`, verify the referenced service has a
// `healthcheck:` block. If missing, downgrade the depender's
// `condition` from `service_healthy` → `service_started`. The depender
// still waits for the dependency to start, just not for a healthcheck
// that doesn't exist.
//
// This complements (does not duplicate) directive-validator: that one
// strips healthchecks for missing-binary cases AND downgrades; this one
// downgrades when the healthcheck was never present.

import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

/**
 * Find every (depender, dependency) pair where the depender declares
 *   depends_on:
 *     <dependency>:
 *       condition: service_healthy
 * and the dependency service has no `healthcheck:` block.
 *
 * Returns an array of { depender, dependency } pairs. Empty array when
 * the compose file is well-formed.
 */
export function scanComposeForHealthcheckConsistency(workspaceDir) {
  const composePath = path.join(workspaceDir, 'docker-compose.yml');
  if (!fs.existsSync(composePath)) return [];

  let compose;
  try {
    compose = YAML.parse(fs.readFileSync(composePath, 'utf8'));
  } catch {
    return [];
  }

  const services = compose?.services;
  if (!services || typeof services !== 'object') return [];

  const issues = [];
  for (const [depender, service] of Object.entries(services)) {
    const dep = service?.depends_on;
    if (!dep || typeof dep !== 'object' || Array.isArray(dep)) continue;

    for (const [dependency, entry] of Object.entries(dep)) {
      if (!entry || typeof entry !== 'object') continue;
      if (entry.condition !== 'service_healthy') continue;

      const target = services[dependency];
      // dependency missing entirely is a separate bug class — skip
      // (compose validation will surface "service X depends on missing Y").
      if (!target || typeof target !== 'object') continue;

      const hc = target.healthcheck;
      const hasHealthcheck = hc
        && typeof hc === 'object'
        && (hc.test !== undefined || hc.cmd !== undefined);
      if (!hasHealthcheck) {
        issues.push({ depender, dependency });
      }
    }
  }
  return issues;
}

/**
 * Apply the downgrade for each issue: rewrite
 *   services.<depender>.depends_on.<dependency>.condition
 * from `service_healthy` to `service_started`, preserving the rest of
 * the YAML formatting via yaml's Document API.
 *
 * Returns an array of applied fixes (one entry per issue).
 */
export function applyHealthcheckConsistencyFixes(workspaceDir, issues) {
  if (!issues.length) return [];
  const composePath = path.join(workspaceDir, 'docker-compose.yml');
  if (!fs.existsSync(composePath)) return [];

  const source = fs.readFileSync(composePath, 'utf8');
  const doc = YAML.parseDocument(source);
  const applied = [];

  for (const { depender, dependency } of issues) {
    doc.setIn(
      ['services', depender, 'depends_on', dependency, 'condition'],
      'service_started'
    );
    applied.push({ depender, dependency });
  }

  if (applied.length) {
    fs.writeFileSync(composePath, doc.toString(), 'utf8');
  }
  return applied;
}
