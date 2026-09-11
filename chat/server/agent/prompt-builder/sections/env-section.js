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

  // Detected stack — an existing project continues in ITS stack (core rule);
  // the TypeScript default applies to fresh projects only.
  const st = env.stack;
  if (st) {
    const chosen = ['backend', 'frontend', 'database', 'vectordb']
      .filter((k) => st[k] && st[k] !== 'none')
      .map((k) => `${k}=${st[k]}`);
    if (chosen.length > 0) {
      lines.push(`Detected stack: ${chosen.join(', ')} — continue in this stack; do not convert languages or frameworks unless the user explicitly asks.`);
    }
    if (st.retired && st.retired !== 'none') {
      lines.push(`Retired layer(s): ${st.retired} — keep building on them; migration only via .platform-rules/scope-migration.md with the user's explicit yes.`);
    }
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

  // Template version / pending platform sync PR
  if (env.templateVersion?.needsUpdate) {
    lines.push(`WARNING: Template update available (${env.templateVersion.current} → ${env.templateVersion.latest})`);
  }
  const tc = env.templateCheck;
  if (tc?.pr) {
    lines.push(`WARNING: Platform sync PR #${tc.pr.number} is open (${tc.pr.url})${tc.pr.heldWorkflows ? ' — after merging, workflow files still need `bash scripts/apply-updates.sh` + commit' : ''}. Mention it and offer to apply it${tc.autoUpdate ? '; auto-update is ON for this repo — apply it without asking' : ''}.`);
  }
  if (tc?.caller === 'outdated' || tc?.caller === 'missing') {
    lines.push('WARNING: This repo\'s weekly template sync cannot reach the template (pre-platform workflow copy). One `bash scripts/apply-updates.sh` run + commit fixes it — offer that.');
  }
  if (tc?.pendingWorkflows) {
    lines.push(`WARNING: The last platform sync left workflow file(s) for a human commit (${tc.pendingWorkflows}). Offer to run bash scripts/apply-updates.sh and commit those files + .template-version.`);
  }
  if (tc?.tsMigration) {
    lines.push(`OPTIONAL: JavaScript layer(s) (${tc.tsMigration}) could move to the TypeScript layout — offer it in one sentence at most once, only do it on an explicit yes (.platform-rules/scope-typescript.md).`);
  }
  if (tc?.migrationNeeded) {
    lines.push(`NOTE: This project is on a retired stack (${tc.migrationNeeded}). Keep building in its existing stack; offer the migration (.platform-rules/scope-migration.md) once, only migrate with an explicit yes.`);
  } else if (tc?.majorHeld) {
    lines.push(`NOTE: Template v${tc.majorHeld.major} is available but held (security files synced). Mention once; accept only when the user says so (TEMPLATE_ACCEPT_MAJOR=1 bash scripts/apply-updates.sh).`);
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
