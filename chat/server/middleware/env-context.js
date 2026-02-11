import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { WORKSPACE_DIR } from '../paths.js';

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

  // Check deployment status from PROJECT_STATUS.md
  if (status.deploymentStatus && !status.deploymentStatus.includes('Not deployed')) {
    return 'deployed';
  }

  // Has docker-compose and at least one Dockerfile → could be testing
  if (s.dockerCompose && (s.frontendDockerfile || s.backendDockerfile)) {
    return 'testing';
  }

  // Has frontend or backend folder → building
  if (s.frontend || s.backend) {
    return 'building';
  }

  return 'empty';
}

function parseProjectStatus() {
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

function checkTemplateVersion() {
  const scriptPath = path.join(WORKSPACE_DIR, 'scripts', 'check-updates.sh');
  if (!existsSync(scriptPath)) {
    return { current: null, latest: null, needsUpdate: false };
  }

  try {
    const output = execSync(`bash "${scriptPath}" 2>/dev/null`, {
      cwd: WORKSPACE_DIR,
      encoding: 'utf-8',
      timeout: 10000,
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
