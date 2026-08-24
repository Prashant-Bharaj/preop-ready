import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { WORKSPACE_DIR } from '../../core/paths.js';
import { GIT_QUICK_MS, BASH_SCRIPT_MS } from '../../config/defaults.js';

let cachedContext = null;

/**
 * Gather environment and project state. Cached after first call,
 * use refresh() to update between messages.
 */
export async function gatherEnvContext() {
  cachedContext = {
    environment: detectEnvironment(),
    codespaceUrl: buildCodespaceUrl(),
    projectPhase: detectProjectPhase(),
    hasStructure: scanProjectStructure(),
    projectStatus: parseProjectStatus(),
    templateVersion: checkTemplateVersion(),
    recentCommits: getRecentCommits(),
    hasUncommittedChanges: hasUncommittedChanges(),
  };
  console.log('[middleware] envContext gathered: phase=%s env=%s', cachedContext.projectPhase, cachedContext.environment);
  return cachedContext;
}

/**
 * Quick refresh — re-scans structure and status (files may have changed after Cline ran).
 */
export async function refreshEnvContext() {
  if (!cachedContext) return gatherEnvContext();
  cachedContext.projectPhase = detectProjectPhase();
  cachedContext.hasStructure = scanProjectStructure();
  cachedContext.projectStatus = parseProjectStatus();
  cachedContext.recentCommits = getRecentCommits();
  cachedContext.hasUncommittedChanges = hasUncommittedChanges();
  return cachedContext;
}

export function getCachedEnvContext() {
  return cachedContext;
}

// ── Internal helpers ──

function detectEnvironment() {
  return process.env.CODESPACES === 'true' ? 'codespaces' : 'local';
}

function buildCodespaceUrl() {
  if (process.env.CODESPACES !== 'true') return null;
  const name = process.env.CODESPACE_NAME || '';
  return name ? `https://${name}-8080.app.github.dev` : null;
}

function scanProjectStructure() {
  const check = (rel) => existsSync(path.join(WORKSPACE_DIR, rel));
  return {
    frontend: check('frontend') || check('frontend/Dockerfile'),
    backend: check('backend') || check('backend/Dockerfile'),
    database: check('database') || check('docker-compose.yml'),
    vectordb: check('vectordb'),
    frontendDockerfile: check('frontend/Dockerfile'),
    backendDockerfile: check('backend/Dockerfile'),
    nginxConf: check('frontend/nginx.conf'),
    nginxLocalConf: check('frontend/nginx.local.conf'),
    dockerCompose: check('docker-compose.yml'),
  };
}

function detectProjectPhase() {
  const s = scanProjectStructure();
  const status = parseProjectStatus();

  // Check deployment status from PROJECT_STATUS.md.
  // Use an explicit positive match — the old "not 'Not deployed'" heuristic
  // wrongly flagged strings like "Running on Codespaces" or "Ready for testing"
  // as deployed. Require the word "deployed" (case-insensitive) with a leading
  // word boundary, and make sure it's NOT negated by "not"/"un".
  if (status.deploymentStatus) {
    const s = status.deploymentStatus.toLowerCase();
    const mentionsDeployed = /\bdeployed\b/.test(s);
    const negated = /\b(not|never|un)\s*deployed\b/.test(s) || s.includes('not deployed');
    if (mentionsDeployed && !negated) return 'deployed';
  }

  // Real app code exists if there are actual source files beyond the
  // template-shipped Dockerfile stubs. Matches the preflight checklist in
  // environment.js — the previous folder-existence check wrongly reported
  // 'building' for fresh templates, which then triggered auto-resume of a
  // prior Cline task on every new browser session.
  const check = (rel) => existsSync(path.join(WORKSPACE_DIR, rel));
  const hasFrontendCode = check('frontend/index.html') || check('frontend/src') || check('frontend/package.json');
  const hasBackendCode = check('backend/src/index.ts') || check('backend/src/index.js')
    || check('backend/src/main.py') || check('backend/main.py')
    || check('backend/package.json') || check('backend/requirements.txt');
  const hasAppCode = hasFrontendCode || hasBackendCode;

  // Has docker-compose + real code → testing
  if (hasAppCode && s.dockerCompose && (s.frontendDockerfile || s.backendDockerfile)) {
    return 'testing';
  }

  // Has real app code → building
  if (hasAppCode) {
    return 'building';
  }

  return 'empty';
}

export function parseProjectStatus() {
  const statusPath = path.join(WORKSPACE_DIR, 'docs', 'PROJECT_STATUS.md');
  if (!existsSync(statusPath)) {
    return { idea: null, stack: null, completedTasks: [], deploymentStatus: null };
  }

  try {
    const content = readFileSync(statusPath, 'utf-8');

    // Extract project idea from the table (strip trailing | from markdown)
    const ideaMatch = content.match(/\*\*Project Idea\*\*\s*\|\s*(.+)/);
    const idea = ideaMatch ? ideaMatch[1].replace(/\s*\|\s*$/, '').trim() : null;

    // Extract stack components
    const stackLines = [];
    const frontendMatch = content.match(/\*\*Frontend\*\*\s*\|\s*(\S+)\s*\|\s*(.+)/);
    const backendMatch = content.match(/\*\*Backend\*\*\s*\|\s*(\S+)\s*\|\s*(.+)/);
    const dbMatch = content.match(/\*\*Database\*\*\s*\|\s*(\S+)\s*\|\s*(.+)/);
    if (frontendMatch && !frontendMatch[1].includes('⬜')) stackLines.push('Frontend: ' + frontendMatch[2].replace(/\s*\|\s*$/, '').trim());
    if (backendMatch && !backendMatch[1].includes('⬜')) stackLines.push('Backend: ' + backendMatch[2].replace(/\s*\|\s*$/, '').trim());
    if (dbMatch && !dbMatch[1].includes('⬜')) stackLines.push('Database: ' + dbMatch[2].replace(/\s*\|\s*$/, '').trim());

    // Extract completed tasks
    const completedSection = content.match(/## ✅ Completed Tasks\n([\s\S]*?)(?=\n## )/);
    const completedTasks = [];
    if (completedSection) {
      const lines = completedSection[1].split('\n').filter(l => l.trim().startsWith('-'));
      for (const line of lines) {
        completedTasks.push(line.replace(/^-\s*/, '').trim());
      }
    }

    // Extract deployment status (strip trailing | from markdown)
    const deployMatch = content.match(/\*\*Status\*\*\s*\|\s*(.+)/);
    const deploymentStatus = deployMatch ? deployMatch[1].replace(/\s*\|\s*$/, '').trim() : null;

    return {
      idea: idea === '_Awaiting user input_' ? null : idea,
      stack: stackLines.length > 0 ? stackLines.join(', ') : null,
      completedTasks,
      deploymentStatus,
    };
  } catch {
    return { idea: null, stack: null, completedTasks: [], deploymentStatus: null };
  }
}

/**
 * Last ~10 commits as one-line "SHA title" strings. Used by the router in
 * continuation mode so it can reference what's been built recently without
 * the user spelling it out again. Returns [] if not a git repo or git fails.
 */
export function getRecentCommits() {
  try {
    const output = execSync('git log --oneline -10 2>/dev/null', {
      cwd: WORKSPACE_DIR,
      encoding: 'utf-8',
      timeout: GIT_QUICK_MS,
    }).trim();
    if (!output) return [];
    return output.split('\n').map(line => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * True if `git status --porcelain` reports any modified/untracked files.
 * Used by the router to mention in-flight work when relevant.
 */
export function hasUncommittedChanges() {
  try {
    const output = execSync('git status --porcelain 2>/dev/null', {
      cwd: WORKSPACE_DIR,
      encoding: 'utf-8',
      timeout: GIT_QUICK_MS,
    });
    return output.trim().length > 0;
  } catch {
    return false;
  }
}

function checkTemplateVersion() {
  const scriptPath = path.join(WORKSPACE_DIR, 'scripts', 'check-updates.sh');
  if (!existsSync(scriptPath)) {
    return { current: null, latest: null, needsUpdate: false };
  }

  try {
    const output = execSync(`bash "${scriptPath}" 2>/dev/null`, {
      cwd: WORKSPACE_DIR,
      encoding: 'utf-8',
      timeout: BASH_SCRIPT_MS,
    }).trim();

    if (output.startsWith('UP_TO_DATE')) {
      return { current: 'latest', latest: 'latest', needsUpdate: false };
    }
    if (output.startsWith('UPDATE_AVAILABLE')) {
      const parts = output.split('|');
      return { current: parts[1] || '?', latest: parts[2] || '?', needsUpdate: true };
    }
    return { current: null, latest: null, needsUpdate: false };
  } catch {
    return { current: null, latest: null, needsUpdate: false };
  }
}
