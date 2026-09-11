// Pre-`compose up` static scan + Strategy-A fix for the bug class:
// a Dockerfile or docker-compose directive (typically a healthcheck)
// invokes a binary that isn't on the chosen base image's PATH. `compose
// build` returns 0 — healthchecks aren't validated at build — but `compose
// up` then fails at runtime when the directive can't find its command.
//
// We catch this BEFORE `compose up` via deterministic static scan rather
// than relying on prompt-side guidance, which has been observed to miss
// this bug class repeatedly. Strategy A (strip the broken directive,
// downgrade dependent depends_on to service_started) is robust in a way
// that prompt edits aren't.

import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

// Image → list of common binaries that are NOT on the image's PATH. Patterns
// match against the image string from `image:` or the runtime FROM in
// Dockerfile (last FROM in multi-stage).
const STRIPPED_IMAGES = [
  { match: (img) => /^chromadb\/chroma(:|$)/.test(img), missing: ['curl', 'wget', 'bash', 'uvicorn'] },
  { match: (img) => /^postgres(:|$)/.test(img), missing: ['curl', 'wget'] },
  { match: (img) => /^redis(:|$)/.test(img), missing: ['curl', 'wget'] },
  { match: (img) => /^nginx:alpine(:|$)/.test(img), missing: ['curl', 'bash'] },
  // Alpine variants (node:*-alpine, python:*-alpine, etc.) ship without
  // bash AND without curl/wget by default. The canonical alpine miss is
  // `curl -f http://localhost:3000/health` in a healthcheck
  // when the backend is node:22-alpine — `compose build` passes, healthcheck
  // exits 127 ("not found") on every retry, dependent service never starts,
  // compose-up returns ok=false. Strategy A (strip the healthcheck) recovers.
  { match: (img) => /-alpine(:|$)/.test(img) || /:alpine$/.test(img), missing: ['bash', 'curl', 'wget'] },
];

function lastFromInDockerfile(dockerfilePath) {
  if (!fs.existsSync(dockerfilePath)) return null;
  const content = fs.readFileSync(dockerfilePath, 'utf8');
  const matches = [...content.matchAll(/^FROM\s+([^\s\n]+)/gm)];
  return matches.length > 0 ? matches[matches.length - 1][1] : null;
}

function resolveServiceImage(service, workspaceDir) {
  if (service?.image) return String(service.image);
  if (service?.build) {
    const buildPath = typeof service.build === 'string' ? service.build : service.build?.context;
    if (!buildPath) return null;
    const dockerfilePath = path.join(workspaceDir, buildPath, 'Dockerfile');
    return lastFromInDockerfile(dockerfilePath);
  }
  return null;
}

function findStrippedRule(image) {
  return STRIPPED_IMAGES.find((rule) => rule.match(image)) || null;
}

function detectMissingBin(cmdString, missing) {
  for (const bin of missing) {
    if (new RegExp(`(?:^|[\\s/])${bin}(?:\\s|$)`).test(cmdString)) return bin;
  }
  return null;
}

export function scanComposeForBadDirectives(workspaceDir) {
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
  for (const [serviceName, service] of Object.entries(services)) {
    if (!service || typeof service !== 'object') continue;
    const image = resolveServiceImage(service, workspaceDir);
    if (!image) continue;
    const rule = findStrippedRule(image);
    if (!rule) continue;

    const hcTest = service.healthcheck?.test;
    if (hcTest) {
      const cmd = Array.isArray(hcTest) ? hcTest.join(' ') : String(hcTest);
      const missingBin = detectMissingBin(cmd, rule.missing);
      if (missingBin) {
        issues.push({ kind: 'healthcheck', service: serviceName, image, missingBin, cmd });
      }
    }
  }

  return issues;
}

export function applyStrategyAFixes(workspaceDir, issues) {
  if (!issues.length) return [];
  const composePath = path.join(workspaceDir, 'docker-compose.yml');
  let source;
  try {
    source = fs.readFileSync(composePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const doc = YAML.parseDocument(source);
  const compose = doc.toJS();
  const applied = [];

  for (const issue of issues) {
    if (issue.kind !== 'healthcheck') continue;

    doc.deleteIn(['services', issue.service, 'healthcheck']);

    const downgraded = [];
    const services = compose?.services || {};
    for (const [otherName, other] of Object.entries(services)) {
      if (otherName === issue.service) continue;
      const dep = other?.depends_on;
      if (!dep || typeof dep !== 'object' || Array.isArray(dep)) continue;
      const entry = dep[issue.service];
      if (entry && typeof entry === 'object' && entry.condition === 'service_healthy') {
        doc.setIn(['services', otherName, 'depends_on', issue.service, 'condition'], 'service_started');
        downgraded.push(otherName);
      }
    }

    applied.push({
      kind: 'healthcheck',
      service: issue.service,
      image: issue.image,
      missingBin: issue.missingBin,
      downgraded,
    });
  }

  if (applied.length) {
    fs.writeFileSync(composePath, doc.toString(), 'utf8');
  }
  return applied;
}
