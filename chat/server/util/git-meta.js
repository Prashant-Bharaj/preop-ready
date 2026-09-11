import { execSync } from 'node:child_process';
import { WORKSPACE_DIR } from '../core/paths.js';
import { GIT_META_MS } from '../config/defaults.js';

export function getGitMeta() {
  // `stdio[2] = 'ignore'` silences git's "fatal: not a git repository"
  // stderr noise when WORKSPACE_DIR is a temp dir (smoke runs, sandboxed
  // environments). The catch below handles the throw — we don't need the
  // diagnostic on stderr.
  const opts = {
    cwd: WORKSPACE_DIR,
    encoding: 'utf-8',
    timeout: GIT_META_MS,
    stdio: ['ignore', 'pipe', 'ignore'],
  };
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', opts).trim();
    const commitSha = execSync('git rev-parse HEAD', opts).trim();
    return { branch, commitSha };
  } catch {
    return { branch: 'unknown', commitSha: 'unknown' };
  }
}
