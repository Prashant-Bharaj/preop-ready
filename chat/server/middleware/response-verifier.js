import { execSync } from 'node:child_process';
import { WORKSPACE_DIR } from '../paths.js';

const MAX_AUTO_RETRIES = 2;

/**
 * Check if Docker containers are healthy after Cline completes a task.
 * Returns { healthy, errors, logs } with actionable error info.
 */
export async function verifyAppHealth() {
  try {
    // 1. Check if docker-compose is running
    const ps = runCommand('docker-compose ps --format json 2>/dev/null || docker compose ps --format json 2>/dev/null');
    if (!ps.trim()) {
      // No containers running — might be expected (no docker task ran)
      return { healthy: true, errors: [], logs: '', containersRunning: false };
    }

    // Parse container statuses
    const containers = parseContainerStatus(ps);
    const unhealthy = containers.filter(c => c.status !== 'running');

    if (unhealthy.length === 0) {
      // All running — do a quick health endpoint check
      const healthCheck = await checkHealthEndpoints(containers);
      if (healthCheck.healthy) {
        return { healthy: true, errors: [], logs: '', containersRunning: true };
      }
      return {
        healthy: false,
        errors: healthCheck.errors,
        logs: healthCheck.logs,
        containersRunning: true,
      };
    }

    // Some containers are down — get logs
    const logs = runCommand('docker-compose logs --tail=40 2>&1 || docker compose logs --tail=40 2>&1');
    const errorLines = extractErrorLines(logs);

    return {
      healthy: false,
      errors: unhealthy.map(c => `Container "${c.name}" is ${c.status}`).concat(errorLines),
      logs: logs.slice(-3000), // cap at 3KB to avoid huge prompts
      containersRunning: true,
    };
  } catch (err) {
    console.error('[middleware] Health check failed:', err.message);
    // Don't block on health check failures
    return { healthy: true, errors: [], logs: '', containersRunning: false };
  }
}

/**
 * Build an error prompt to send back to Cline for auto-fix.
 */
export function buildErrorPrompt(healthResult) {
  const lines = [
    '=== APPLICATION HEALTH CHECK FAILED ===',
    '',
    'After your last changes, the application is not working correctly.',
    'Please fix the following issues:',
    '',
  ];

  for (const error of healthResult.errors) {
    lines.push(`- ${error}`);
  }

  if (healthResult.logs) {
    lines.push('');
    lines.push('=== RECENT DOCKER LOGS ===');
    lines.push(healthResult.logs);
  }

  lines.push('');
  lines.push('Fix these errors and rebuild with docker-compose up --build -d');

  return lines.join('\n');
}

/**
 * Determine if a Cline task involved Docker commands (so we should verify).
 * Call this by checking events emitted during the task.
 */
export function shouldVerify(clineEvents) {
  const dockerKeywords = ['docker-compose', 'docker compose', 'docker build', 'docker run'];
  for (const event of clineEvents) {
    if (event.say === 'command') {
      const cmd = typeof event.text === 'string' ? event.text : '';
      if (dockerKeywords.some(kw => cmd.includes(kw))) return true;
    }
  }
  return false;
}

/**
 * Check if we've exceeded the auto-retry limit.
 */
export function canRetry(session) {
  return (session.retryCount || 0) < MAX_AUTO_RETRIES;
}

// ── Internal helpers ──

function runCommand(cmd) {
  try {
    return execSync(cmd, {
      cwd: WORKSPACE_DIR,
      encoding: 'utf-8',
      timeout: 15000,
    });
  } catch (err) {
    return err.stdout || err.stderr || '';
  }
}

function parseContainerStatus(psOutput) {
  const containers = [];
  const lines = psOutput.trim().split('\n');

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      containers.push({
        name: obj.Name || obj.name || 'unknown',
        status: (obj.State || obj.status || '').toLowerCase(),
        service: obj.Service || obj.service || '',
      });
    } catch {
      // Not JSON — try parsing text format
      // Typical format: NAME  SERVICE  STATUS  PORTS
      const parts = line.split(/\s{2,}/);
      if (parts.length >= 3) {
        containers.push({
          name: parts[0],
          status: parts[2]?.toLowerCase().includes('up') ? 'running' : 'exited',
          service: parts[1] || '',
        });
      }
    }
  }

  return containers;
}

async function checkHealthEndpoints(containers) {
  const errors = [];
  const endpoints = [
    { url: 'http://localhost:8080/health', name: 'frontend' },
    { url: 'http://localhost:3001/health', name: 'backend' },
  ];

  for (const ep of endpoints) {
    // Only check if the relevant service seems to be running
    const hasService = containers.some(c =>
      c.service.includes(ep.name) || c.name.includes(ep.name)
    );
    if (!hasService) continue;

    try {
      const result = runCommand(`curl -sf -m 5 ${ep.url} 2>/dev/null`);
      if (!result.trim()) {
        errors.push(`${ep.name} health endpoint (${ep.url}) returned empty response`);
      }
    } catch {
      errors.push(`${ep.name} health endpoint (${ep.url}) is not responding`);
    }
  }

  if (errors.length > 0) {
    const logs = runCommand('docker-compose logs --tail=30 2>&1 || docker compose logs --tail=30 2>&1');
    return { healthy: false, errors, logs: logs.slice(-3000) };
  }

  return { healthy: true, errors: [], logs: '' };
}

function extractErrorLines(logs) {
  const errorPatterns = [
    /error/i,
    /fatal/i,
    /exception/i,
    /exit code [1-9]/i,
    /ENOENT/,
    /EACCES/,
    /Cannot find module/,
    /SyntaxError/,
    /TypeError/,
    /ReferenceError/,
  ];

  const lines = logs.split('\n');
  const errorLines = [];

  for (const line of lines) {
    if (errorPatterns.some(p => p.test(line))) {
      const trimmed = line.trim().slice(0, 200); // cap line length
      if (trimmed && !errorLines.includes(trimmed)) {
        errorLines.push(trimmed);
      }
    }
  }

  return errorLines.slice(0, 10); // max 10 error lines
}
