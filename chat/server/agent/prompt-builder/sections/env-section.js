import { WORKSPACE_DIR } from '../../../core/paths.js';
import { listAppSecretSummaries } from '../../../core/app-secrets-scaffold.js';

export function buildEnvSection(env) {
  if (!env) return '=== ENVIRONMENT ===\nNo environment data available.';

  const lines = ['=== ENVIRONMENT ==='];

  lines.push(`Running in: ${env.environment === 'codespaces' ? 'GitHub Codespace' : 'Local development'}`);

  if (env.codespaceUrl) {
    lines.push(`Testing URL: ${env.codespaceUrl}`);
  } else if (env.environment === 'local') {
    lines.push('Testing URL: http://localhost:8080');
  }

  lines.push(`Project phase: ${env.projectPhase}`);

  // Structure
  const parts = [];
  if (env.hasStructure?.frontend) parts.push('frontend');
  if (env.hasStructure?.backend) parts.push('backend');
  if (env.hasStructure?.database) parts.push('database');
  if (env.hasStructure?.vectordb) parts.push('vectordb');
  if (parts.length > 0) {
    lines.push(`Existing components: ${parts.join(', ')}`);
  } else {
    lines.push('Existing components: none (fresh project)');
  }

  // Project status
  if (env.projectStatus) {
    if (env.projectStatus.idea) {
      lines.push(`Project idea: ${env.projectStatus.idea}`);
    }
    if (env.projectStatus.stack) {
      lines.push(`Stack: ${env.projectStatus.stack}`);
    }
    if (env.projectStatus.completedTasks?.length > 0) {
      lines.push(`Recently completed: ${env.projectStatus.completedTasks.slice(-3).join('; ')}`);
    }
  }

  // Template version
  if (env.templateVersion?.needsUpdate) {
    lines.push(`WARNING: Template update available (${env.templateVersion.current} → ${env.templateVersion.latest})`);
  }

  // App secrets — names + descriptions + isSet, never values. Read fresh from
  // backend/.env each time. If the file doesn't exist yet, listAppSecretSummaries
  // returns the static slot list with isSet=false — still a useful menu.
  try {
    const slots = listAppSecretSummaries(WORKSPACE_DIR);
    if (slots.length > 0) {
      lines.push('');
      lines.push('Available secret slots (read via process.env.<NAME> — never hardcode the value):');
      for (const slot of slots) {
        const status = slot.isSet ? 'set' : 'unset';
        const tail = slot.description ? ` — ${slot.description}` : '';
        const kindHint = slot.kind === 'generic' && !slot.description
          ? ' — generic reusable slot (Stripe, Twilio, Bayer LLM, etc.)'
          : '';
        lines.push(`- ${slot.name} (${status})${tail}${kindHint}`);
      }
      lines.push('Pick the slot whose description matches your need. If none match and you need a third-party key, use SECRET_1/2/3 — anything else won\'t reach the deployed container.');
    }
  } catch {
    // Best-effort — never let a stat/read error break prompt assembly.
  }

  return lines.join('\n');
}
