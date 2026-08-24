import { existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { WORKSPACE_DIR } from './paths.js';
import { getCachedEnvContext, refreshEnvContext } from '../agent/context/env-context.js';
import { routeMessage } from '../agent/planner/two-agent.js';
import { DOCKER_INFO_PROBE_MS, ENV_DETECT_MS } from '../config/defaults.js';
import { logAndSwallow } from '../util/log-helpers.js';

/**
 * Run Node.js-based preflight checks (mirrors scripts/preflight-check.sh).
 * Returns structured JSON with user-friendly labels.
 */
function runPreflightChecks() {
  const checks = [];
  const ws = WORKSPACE_DIR;
  const check = (rel) => existsSync(path.join(ws, rel));

  // ── Project Structure ──
  // Template ships with frontend/ and backend/ containing only Dockerfile templates
  // and config examples. Check for actual source files to detect real app code.
  const hasFrontendCode = check('frontend/index.html') || check('frontend/src') || check('frontend/package.json');
  const hasBackendCode = check('backend/src/index.ts') || check('backend/src/index.js')
    || check('backend/src/main.py') || check('backend/main.py')
    || check('backend/package.json') || check('backend/requirements.txt');
  checks.push({
    id: 'project-folders',
    label: 'App code created',
    description: hasFrontendCode && hasBackendCode
      ? 'Both frontend and backend code exist'
      : hasFrontendCode ? 'Frontend code exists'
      : hasBackendCode ? 'Backend code exists'
      : 'No app code yet — describe your idea to get started',
    status: (hasFrontendCode || hasBackendCode) ? 'pass' : 'pending',
    category: 'structure',
  });

  // ── Dockerfiles ──
  // Backend only has template variants (Dockerfile.node, Dockerfile.python) until the AI creates the real one
  const hasFrontendDocker = check('frontend/Dockerfile');
  const hasBackendDocker = check('backend/Dockerfile');

  if (hasFrontendCode || hasBackendCode) {
    const hasAppDocker = (hasFrontendCode && hasFrontendDocker) || (hasBackendCode && hasBackendDocker);
    checks.push({
      id: 'dockerfiles',
      label: 'Build configuration',
      description: hasAppDocker
        ? 'Dockerfiles are set up for building your app'
        : 'Dockerfiles not created yet — the AI will set these up',
      status: hasAppDocker ? 'pass' : 'pending',
      category: 'build',
    });
  }

  // ── nginx.conf (frontend) ──
  if (hasFrontendCode) {
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
      execSync('docker info', { stdio: 'ignore', timeout: DOCKER_INFO_PROBE_MS });
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

  // POST /api/environment/test-router — test the assistant router in isolation
  app.post('/api/environment/test-router', async (req, res) => {
    const { message, conversationId } = req.body;
    if (!message) {
      return res.status(400).json({ error: 'message is required' });
    }

    try {
      const t0 = Date.now();
      const envContext = getCachedEnvContext() || await refreshEnvContext();
      const tEnv = Date.now();

      const result = await routeMessage(message, envContext, { conversationId });
      const tRouter = Date.now();

      res.json({
        ...result,
        timing: {
          envContextMs: tEnv - t0,
          routerMs: tRouter - tEnv,
          totalMs: tRouter - t0,
        },
      });
    } catch (err) {
      logAndSwallow(err, '[test-router] Error');
      res.status(500).json({ error: err.message });
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

  // GET /api/docker/status — cheap check for "are our compose containers up?"
  // Used by the UI to show Stop/Run quick-action reliably across reloads.
  app.get('/api/docker/status', (_req, res) => {
    try {
      const out = execSync(
        'docker compose ps --format json 2>/dev/null || docker-compose ps --format json 2>/dev/null',
        { cwd: WORKSPACE_DIR, encoding: 'utf-8', timeout: ENV_DETECT_MS }
      ).trim();
      // `docker compose ps --format json` emits NDJSON (one container per line) when services are up,
      // and nothing (or "[]") when they're all down.
      const running = out.length > 2 && out !== '[]';
      res.json({ running });
    } catch {
      res.json({ running: false });
    }
  });

}
