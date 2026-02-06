import { execSync } from 'node:child_process';
import { WORKSPACE_DIR } from './paths.js';

export function getGitMeta() {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: WORKSPACE_DIR,
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    const commitSha = execSync('git rev-parse HEAD', {
      cwd: WORKSPACE_DIR,
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    return { branch, commitSha };
  } catch {
    return { branch: 'unknown', commitSha: 'unknown' };
  }
}
