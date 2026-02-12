/**
 * Prompt Builder — assembles an enriched prompt from:
 *   - Environment context (env-context.js)
 *   - Selected rules + snippets (from router specification)
 *   - Task description (from router or raw user message)
 *
 * The enriched prompt replaces the raw user message when sent to Cline,
 * giving the corp LLM full awareness of the environment and relevant
 * pre-built code without needing to read all 19 rule files.
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { WORKSPACE_DIR } from '../paths.js';

const CLINERULES_DIR = path.join(WORKSPACE_DIR, '.clinerules');
const SNIPPETS_DIR = path.join(WORKSPACE_DIR, 'snippets');

// Rules that are ALWAYS included regardless of router selection
const ALWAYS_INCLUDE_RULES = ['10-platform-rules.md', '18-security.md'];

/**
 * Build an enriched prompt from a router task specification.
 * Supports both old single-task format and new multi-task format.
 *
 * @param {{ tasks: Array<{scope, task, rules, snippets}>, message: string }} routerSpec
 * @param {object} envContext - From env-context.js
 * @returns {string} The enriched prompt for Cline
 */
export function buildPromptFromSpec(routerSpec, envContext) {
  const tasks = routerSpec.tasks || [];

  // Merge rules and snippets from all tasks + always-included
  const allRules = new Set(ALWAYS_INCLUDE_RULES);
  const allSnippets = new Set();
  for (const t of tasks) {
    (t.rules || []).forEach(r => allRules.add(r));
    (t.snippets || []).forEach(s => allSnippets.add(s));
  }

  const rulesContent = readRuleFiles([...allRules]);
  const snippetsContent = readSnippetFiles([...allSnippets]);

  // Build task description — join scoped tasks with headers
  let taskText;
  if (tasks.length === 1) {
    taskText = tasks[0].task;
  } else if (tasks.length > 1) {
    taskText = tasks.map(t => `[${t.scope.toUpperCase()}]\n${t.task}`).join('\n\n');
  } else {
    taskText = routerSpec.message || '';
  }

  return buildPrompt(taskText, envContext, { rulesContent, snippetsContent });
}

/**
 * Build an enriched prompt for a regular user message.
 */
function buildPrompt(userMessage, envContext, selectedContext) {
  const sections = [];

  // ── Environment section ──
  sections.push(buildEnvSection(envContext));

  // ── Rules section ──
  if (selectedContext.rulesContent && Object.keys(selectedContext.rulesContent).length > 0) {
    sections.push(buildRulesSection(selectedContext));
  }

  // ── Snippets section ──
  if (selectedContext.snippetsContent && Object.keys(selectedContext.snippetsContent).length > 0) {
    sections.push(buildSnippetsSection(selectedContext));
  }

  // ── User request (always last) ──
  sections.push(`=== USER REQUEST ===\n${userMessage}`);

  return sections.join('\n\n');
}

/**
 * Build an enriched bootstrap prompt (session start).
 * Combines the static bootstrap file content with dynamic env context.
 */
export function buildBootstrapPrompt(bootstrapContent, envContext, creds) {
  const sections = [bootstrapContent];

  // Mode instruction
  if (creds?.mode === 'developer') {
    sections.push('6. **Developer mode**: The user is experienced. Be concise and technical. Skip explanations of basic concepts. Show commands you run. Use technical terminology freely.');
  } else {
    sections.push('6. **Beginner mode**: The user is new to coding. Use simple, friendly language. Avoid jargon. Do everything for them — never ask them to run commands or edit files. Explain what you are doing in simple terms.');
  }

  // Project type instruction
  if (creds?.projectType === 'migrated') {
    sections.push('7. **Project type**: The user has migrated existing code into this repo. Do NOT ask if they are starting fresh or migrating. Analyze the existing codebase and help them adapt it to the platform requirements.');
  } else {
    sections.push('7. **Project type**: The user is starting fresh. Do NOT ask if they are starting fresh or migrating. Proceed directly to understanding what they want to build.');
  }

  // Dynamic environment context
  sections.push(buildEnvSection(envContext));

  return sections.join('\n\n');
}

// Scope → allowed folder mapping for parallel execution
const SCOPE_FOLDERS = {
  database:    ['database/'],
  vectordb:    ['vectordb/'],
  backend:     ['backend/'],
  frontend:    ['frontend/'],
  integration: ['docker-compose.yml', 'frontend/nginx.conf', 'frontend/nginx.local.conf', 'docs/'],
};

/**
 * Build an enriched prompt for a SINGLE scoped task.
 * Used in parallel execution — each Cline instance gets its own scoped prompt
 * with folder restrictions to prevent file conflicts.
 *
 * @param {{ scope: string, task: string, rules: string[], snippets: string[] }} task
 * @param {object} envContext - From env-context.js
 * @param {{ allTasks: Array }} opts - Full task list for context
 * @returns {string} The enriched prompt for one Cline instance
 */
export function buildScopedPrompt(task, envContext, { allTasks = [] } = {}) {
  const rules = new Set(ALWAYS_INCLUDE_RULES);
  (task.rules || []).forEach(r => rules.add(r));

  const rulesContent = readRuleFiles([...rules]);
  const snippetsContent = readSnippetFiles(task.snippets || []);

  const sections = [];

  // ── Environment section ──
  sections.push(buildEnvSection(envContext));

  // ── Scope restriction ──
  const folders = SCOPE_FOLDERS[task.scope];
  if (folders) {
    const folderList = folders.join(', ');
    sections.push(
      `=== SCOPE RESTRICTION ===\n` +
      `You are working on the ${task.scope.toUpperCase()} scope.\n` +
      `ONLY create or modify files in: ${folderList}\n` +
      `Do NOT touch files outside these paths — other scopes are handled by parallel workers.`
    );
  }

  // ── Context: what other scopes are building (read-only info) ──
  if (allTasks.length > 1) {
    const otherScopes = allTasks
      .filter(t => t.scope !== task.scope)
      .map(t => `- [${t.scope.toUpperCase()}]: ${t.task.slice(0, 150)}`)
      .join('\n');
    sections.push(
      `=== OTHER SCOPES (for reference only — do NOT implement these) ===\n${otherScopes}`
    );
  }

  // ── Rules section ──
  if (Object.keys(rulesContent).length > 0) {
    sections.push(buildRulesSection({ rulesContent }));
  }

  // ── Snippets section ──
  if (Object.keys(snippetsContent).length > 0) {
    sections.push(buildSnippetsSection({ snippetsContent }));
  }

  // ── Task (always last) ──
  sections.push(`=== YOUR TASK (${task.scope.toUpperCase()} scope) ===\n${task.task}`);

  return sections.join('\n\n');
}

// ── Section builders ──

function buildEnvSection(env) {
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

  return lines.join('\n');
}

function buildRulesSection(context) {
  const lines = ['=== RELEVANT RULES (follow these strictly) ==='];

  for (const [file, content] of Object.entries(context.rulesContent)) {
    lines.push(`--- ${file} ---`);
    lines.push(content.trim());
    lines.push('');
  }

  return lines.join('\n');
}

function buildSnippetsSection(context) {
  const lines = [
    '=== AVAILABLE CODE SNIPPETS ===',
    'IMPORTANT: Use these pre-built snippets instead of writing from scratch.',
    'Copy and adapt the code below to the user\'s project.',
    '',
  ];

  for (const [file, content] of Object.entries(context.snippetsContent)) {
    lines.push(`--- snippets/${file} (READY — copy and adapt this) ---`);
    lines.push(content.trim());
    lines.push('');
  }

  return lines.join('\n');
}

// ── File reading helpers ──

function readRuleFiles(files) {
  const contents = {};
  for (const file of files) {
    const filePath = path.join(CLINERULES_DIR, file);
    if (existsSync(filePath)) {
      try { contents[file] = readFileSync(filePath, 'utf-8'); } catch { /* skip */ }
    }
  }
  return contents;
}

function readSnippetFiles(files) {
  const contents = {};
  for (const file of files) {
    const filePath = path.join(SNIPPETS_DIR, file);
    if (existsSync(filePath)) {
      try { contents[file] = readFileSync(filePath, 'utf-8'); } catch { /* skip */ }
    }
  }
  return contents;
}
