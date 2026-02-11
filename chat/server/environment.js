import { existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { WORKSPACE_DIR } from './paths.js';
import { getCachedEnvContext, refreshEnvContext } from './middleware/env-context.js';

/**
 * Run Node.js-based preflight checks (mirrors scripts/preflight-check.sh).
 * Returns structured JSON with user-friendly labels.
 */
function runPreflightChecks() {
  const checks = [];
  const ws = WORKSPACE_DIR;
  const check = (rel) => existsSync(path.join(ws, rel));

  // ── Project Structure ──
  const hasFrontend = check('frontend');
  const hasBackend = check('backend');
  checks.push({
    id: 'project-folders',
    label: 'App code created',
    description: hasFrontend && hasBackend
      ? 'Both frontend and backend folders exist'
      : hasFrontend ? 'Frontend folder exists'
      : hasBackend ? 'Backend folder exists'
      : 'No frontend/ or backend/ folder yet — describe your idea to get started',
    status: (hasFrontend || hasBackend) ? 'pass' : 'pending',
    category: 'structure',
  });

  // ── Dockerfiles ──
  const hasFrontendDocker = check('frontend/Dockerfile');
  const hasBackendDocker = check('backend/Dockerfile');
  const hasAnyDocker = hasFrontendDocker || hasBackendDocker;

  if (hasFrontend || hasBackend) {
    checks.push({
      id: 'dockerfiles',
      label: 'Build configuration',
      description: hasAnyDocker
        ? 'Dockerfiles are set up for building your app'
        : 'Dockerfiles not created yet — the AI will set these up',
      status: hasAnyDocker ? 'pass' : 'pending',
      category: 'build',
    });
  }

  // ── nginx.conf (frontend) ──
  if (hasFrontend) {
    const hasNginx = check('frontend/nginx.conf');
    let nginxOk = false;
    let nginxIssue = '';
    if (hasNginx) {
      try {
        const content = readFileSync(path.join(ws, 'frontend/nginx.conf'), 'utf-8');
        const hasEventsBlock = /^events\s*\{/m.test(content);
        const hasHttpBlock = /^http\s*\{/m.test(content);
        const hasHealth = content.includes('/health');
        if (hasEventsBlock || hasHttpBlock) {
          nginxIssue = 'nginx.conf has invalid blocks — needs fixing';
        } else if (!hasHealth) {
          nginxIssue = 'nginx.conf is missing a health check endpoint';
        } else {
          nginxOk = true;
        }
      } catch {
        nginxIssue = 'Could not read nginx.conf';
      }
    }
    checks.push({
      id: 'nginx-conf',
      label: 'Web server config',
      description: nginxOk
        ? 'nginx.conf is properly configured'
        : hasNginx ? nginxIssue
        : 'nginx.conf not created yet — needed for serving your frontend',
      status: nginxOk ? 'pass' : hasNginx ? 'warn' : 'pending',
      category: 'build',
    });
  }

  // ── docker-compose.yml ──
  const hasCompose = check('docker-compose.yml');
  checks.push({
    id: 'docker-compose',
    label: 'Local testing setup',
    description: hasCompose
      ? 'docker-compose.yml is ready — you can test locally'
      : 'docker-compose.yml not created yet — needed to test your app',
    status: hasCompose ? 'pass' : 'pending',
    category: 'testing',
  });

  // ── Deploy workflow ──
  const hasDeployWorkflow = check('.github/workflows/deploy.yml');
  checks.push({
    id: 'deploy-workflow',
    label: 'Deployment pipeline',
    description: hasDeployWorkflow
      ? 'GitHub Actions workflow is configured'
      : 'Deploy workflow missing — check your template setup',
    status: hasDeployWorkflow ? 'pass' : 'warn',
    category: 'deploy',
  });

  // ── Docker availability ──
  let dockerAvailable = false;
  let dockerRunning = false;
  try {
    execSync('command -v docker', { stdio: 'ignore' });
    dockerAvailable = true;
    try {
      execSync('docker info', { stdio: 'ignore', timeout: 5000 });
      dockerRunning = true;
    } catch { /* not running */ }
  } catch { /* not installed */ }

  checks.push({
    id: 'docker',
    label: 'Docker available',
    description: dockerRunning
      ? 'Docker is installed and running'
      : dockerAvailable ? 'Docker is installed but not running — start Docker Desktop'
      : 'Docker is not installed — use GitHub Codespaces or install Docker',
    status: dockerRunning ? 'pass' : dockerAvailable ? 'warn' : 'fail',
    category: 'runtime',
  });

  // Summary
  const passed = checks.filter(c => c.status === 'pass').length;
  const pending = checks.filter(c => c.status === 'pending').length;
  const warnings = checks.filter(c => c.status === 'warn').length;
  const failed = checks.filter(c => c.status === 'fail').length;

  return { checks, summary: { passed, pending, warnings, failed, total: checks.length } };
}

export function mountEnvironmentRoutes(app) {
  // GET /api/environment — returns env context + preflight checks
  app.get('/api/environment', async (_req, res) => {
    try {
      const envContext = getCachedEnvContext() || await refreshEnvContext();
      const preflight = runPreflightChecks();

      res.json({
        environment: envContext.environment,
        codespaceUrl: envContext.codespaceUrl,
        projectPhase: envContext.projectPhase,
        projectStatus: envContext.projectStatus,
        templateVersion: envContext.templateVersion,
        preflight,
      });
    } catch (err) {
      console.error('[environment] Error:', err);
      res.status(500).json({ error: 'Failed to gather environment info' });
    }
  });

  // POST /api/environment/refresh — force a re-scan
  app.post('/api/environment/refresh', async (_req, res) => {
    try {
      await refreshEnvContext();
      const envContext = getCachedEnvContext();
      const preflight = runPreflightChecks();

      res.json({
        environment: envContext.environment,
        codespaceUrl: envContext.codespaceUrl,
        projectPhase: envContext.projectPhase,
        projectStatus: envContext.projectStatus,
        templateVersion: envContext.templateVersion,
        preflight,
      });
    } catch (err) {
      console.error('[environment] Refresh error:', err);
      res.status(500).json({ error: 'Failed to refresh environment info' });
    }
  });

}
