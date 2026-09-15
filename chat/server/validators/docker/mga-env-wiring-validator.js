/**
 * mga-env-wiring-validator.js — deterministic compose patch: when the
 * workspace `.env` carries MGA_* credentials, the backend service MUST
 * receive them (`env_file: .env`).
 *
 * Why: env wiring used to depend on the integration agent reading the
 * `=== WORKSPACE ENV FILE ===` spawn section — correct on fresh AI builds, but
 * an ITERATE that introduces the app's first AI feature usually doesn't
 * re-dispatch integration at all, so the backend booted without MGA_*
 * (observed live: `MGA_BASE_URL and MGA_API_KEY must be set` rejections).
 * Wiring an env file is fully known — no LLM in the loop. (The credential
 * validator adds the same `env_file: .env` for DATABASE_*; this one covers
 * apps without a database.) Runs with the
 * other pre-compose validators, so it also heals existing apps on their
 * next start.
 */

import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

/**
 * @returns {{ applied: boolean, reason: string }}
 */
export function applyMgaEnvWiringFix(workspaceDir) {
  const envPath = path.join(workspaceDir, '.env');
  const composePath = path.join(workspaceDir, 'docker-compose.yml');
  let envText = '';
  try {
    envText = fs.readFileSync(envPath, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') return { applied: false, reason: 'no .env or compose' };
    return { applied: false, reason: 'env unreadable' };
  }
  if (!/^MGA_/m.test(envText)) return { applied: false, reason: 'no MGA_* in .env' };

  let composeText;
  try {
    composeText = fs.readFileSync(composePath, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') return { applied: false, reason: 'no .env or compose' };
    return { applied: false, reason: 'compose unparseable' };
  }
  let doc;
  try { doc = YAML.parseDocument(composeText); } catch {
    return { applied: false, reason: 'compose unparseable' };
  }
  const backend = doc.getIn(['services', 'backend']);
  if (!backend) return { applied: false, reason: 'no backend service' };

  // Already wired? env_file listing the workspace .env itself (not
  // backend/.env), or MGA_ key in environment.
  const envFile = doc.getIn(['services', 'backend', 'env_file']);
  const existing = envFile == null ? [] : [].concat(typeof envFile.toJSON === 'function' ? envFile.toJSON() : envFile);
  const envFilePaths = existing.map((e) => (typeof e === 'string' ? e : e?.path)).filter(Boolean).map((p) => p.replace(/^\.\//, ''));
  if (envFilePaths.includes('.env')) return { applied: false, reason: 'env_file already present' };
  const environment = doc.getIn(['services', 'backend', 'environment']);
  if (environment && /MGA_/.test(String(environment))) return { applied: false, reason: 'MGA_ env entries already present' };

  doc.setIn(['services', 'backend', 'env_file'], ['.env', ...existing]);
  fs.writeFileSync(composePath, doc.toString());
  return { applied: true, reason: 'added env_file: [.env] to backend service' };
}
