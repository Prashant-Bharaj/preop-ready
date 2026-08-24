#!/usr/bin/env node
/**
 * One-shot migration — tags all .platform-rules/*.md and snippets/**
 * files with frontmatter (scopes + flags) so resolve_context can find them.
 *
 * - The tag mapping is the TAGS object below. Edit there, re-run.
 * - Idempotent: files already carrying a `scopes:` or `flags:` key are left
 *   alone. To retag a file, remove its frontmatter manually first.
 * - Skips file types the frontmatter parser does not support (.conf, .yml,
 *   .sql, Dockerfiles). Those remain fetchable via get_snippet directly but
 *   do not participate in flag-driven resolve_context output.
 *
 * Usage:
 *   node chat/scripts/tag-files.js            # dry-run, prints proposed diffs
 *   node chat/scripts/tag-files.js --apply    # writes changes
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter } from '../server/mcp/frontmatter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// ── Tag mapping ──
// Paths are relative to REPO_ROOT. Each entry is either:
//   - { scopes, flags, description } for files needing tagging
//   - null to explicitly skip (for files we've decided not to tag)

const TAGS = {
  // ─── .platform-rules/ ───────────────────────────────────────────────
  '.platform-rules/global.md': {
    scopes: [], flags: [],
    description: 'Platform invariants applying to every project — ports, folder layout, envs.',
  },
  '.platform-rules/common.md': {
    scopes: [], flags: [],
    description: 'Cross-scope conventions and patterns.',
  },
  '.platform-rules/security.md': {
    scopes: [], flags: [],
    description: 'Baseline security: nginx headers, non-root containers, input validation, parameterised SQL.',
  },
  '.platform-rules/scope-backend.md': {
    scopes: ['backend'], flags: [],
    description: 'Backend scope rules — Express/FastAPI patterns, endpoints, port 3000, /health.',
  },
  '.platform-rules/scope-frontend.md': {
    scopes: ['frontend'], flags: [],
    description: 'Frontend scope rules — React+Vite, nginx, port 8080, API routing.',
  },
  '.platform-rules/scope-database.md': {
    scopes: ['database'], flags: [],
    description: 'Database scope rules — PostgreSQL/MySQL setup, init scripts, connection config.',
  },
  '.platform-rules/scope-vectordb.md': {
    scopes: ['vectordb'], flags: [],
    description: 'Vector DB scope rules — pgvector, ChromaDB, Qdrant setup.',
  },
  '.platform-rules/scope-integration.md': {
    scopes: ['integration'], flags: [],
    description: 'Integration scope rules — docker-compose, env vars, service wiring.',
  },
  '.platform-rules/scope-migration.md': {
    scopes: [], flags: ['migration'],
    description: 'Rules for porting existing code into the template.',
  },
  '.platform-rules/verify-checklist.md': {
    scopes: [], flags: [],
    description: 'Post-build verification checklist — Dockerfiles, compose, nginx, ports, security.',
  },
  '.platform-rules/reference/error-recovery.md': {
    scopes: [], flags: [],
    description: 'Debugging failed builds, crashing containers, health-check failures.',
  },
  '.platform-rules/reference/troubleshooting.md': {
    scopes: [], flags: [],
    description: 'FAQ for common platform issues.',
  },
  '.platform-rules/reference/file-handling.md': {
    scopes: ['backend'], flags: ['file-uploads'],
    description: 'In-app file uploads — memory vs persistent storage, /data mount.',
  },
  '.platform-rules/reference/secrets.md': {
    scopes: ['backend'],
    flags: ['ai-chat', 'ai-rag', 'search-external', 'sharepoint', 'snowflake', 'notifications-email', 'cors-proxy'],
    description: 'Managing API keys, env var patterns, external service auth.',
  },
  '.platform-rules/reference/api-keys.md': {
    scopes: ['backend'],
    flags: ['ai-chat', 'ai-rag', 'search-external', 'sharepoint', 'snowflake'],
    description: 'API key provisioning on the platform (MGA, corp providers, M2M).',
  },
  '.platform-rules/reference/status-tracking.md': {
    scopes: [], flags: [],
    description: 'When and how to update docs/PROJECT_STATUS.md.',
  },
  '.platform-rules/reference/urls.md': {
    scopes: [], flags: [],
    description: 'URL formats — Codespaces vs Local vs Production, detection commands.',
  },
  // user-identity.md is already tagged; leave null so we don't double-tag.
  '.platform-rules/reference/user-identity.md': null,
  '.platform-rules/reference/snippets.md': {
    scopes: [], flags: [],
    description: 'How to use the snippet library — discover, adapt, attribute.',
  },
  '.platform-rules/reference/sensitive-files.md': {
    scopes: [], flags: [],
    description: 'Files never to modify or commit — .env, credentials, real-data seeds.',
  },
  '.platform-rules/reference/deployment.md': {
    scopes: [], flags: [],
    description: 'AWS ECS deployment — whitelisting, preflight, push, URL format.',
  },
  '.platform-rules/reference/background-commands.md': {
    scopes: [], flags: [],
    description: 'Running long-lived commands detached — docker-compose up -d, nohup npm run dev.',
  },
  '.platform-rules/reference/ai-file-input.md': {
    scopes: [], flags: [],
    description: 'User-provided files for AI analysis via the context/ folder, large-file chunking.',
  },

  // ─── snippets/auth/ ─────────────────────────────────────────────────
  // user-identity.js already tagged; leave null.
  'snippets/auth/user-identity.js': null,
  'snippets/auth/user-identity.py': {
    scopes: ['backend'], flags: ['has-users', 'has-admin', 'ai-chat'],
    description: 'FastAPI/Flask middleware — ALB OIDC identity extraction with local-dev fallback.',
  },
  'snippets/auth/user-identity.rs': {
    scopes: ['backend'], flags: ['has-users', 'has-admin', 'ai-chat'],
    description: 'Rust middleware — ALB OIDC identity extraction.',
  },
  'snippets/auth/credentials-fetch.js': {
    scopes: ['backend'], flags: ['sharepoint', 'snowflake'],
    description: 'Fetch per-user credentials from the corporate identity provider for downstream API calls.',
  },
  'snippets/auth/token-refresh.js': {
    scopes: ['backend'], flags: ['has-users'],
    description: 'Token refresh helper for long-lived user sessions.',
  },
  'snippets/auth/user-roles.js': {
    scopes: ['backend'], flags: ['has-admin'],
    description: 'Role check middleware — gate routes by user role (employee/manager/admin).',
  },
  'snippets/auth/user-roles.py': {
    scopes: ['backend'], flags: ['has-admin'],
    description: 'Python role check dependency for FastAPI/Flask.',
  },
  'snippets/auth/user-roles-schema.sql': {
    scopes: ['database'], flags: ['has-admin'],
    description: 'SQL schema for user roles table (id, user_id, role).',
  },
  'snippets/auth/UserManagement.jsx': {
    scopes: ['frontend'], flags: ['has-admin'],
    description: 'React admin page for managing users and assigning roles.',
  },

  // ─── snippets/backend/ ──────────────────────────────────────────────
  // express-server-template.js already tagged; leave null.
  'snippets/backend/express-server-template.js': null,
  'snippets/backend/fastapi-server-template.py': {
    scopes: ['backend'], flags: [],
    description: 'Baseline FastAPI server with CORS, /health, port 3000.',
  },
  'snippets/backend/postgres-connection.js': {
    scopes: ['backend'], flags: [],
    description: 'PostgreSQL connection pool with platform env vars.',
  },
  'snippets/backend/socketio-server.js': {
    scopes: ['backend'], flags: ['real-time'],
    description: 'Socket.IO WebSocket server with room management and presence.',
  },
  'snippets/backend/vectordb-connections.js': {
    scopes: ['backend', 'vectordb'], flags: ['ai-rag'],
    description: 'pgvector connection patterns for RAG.',
  },

  // ─── snippets/config/ ───────────────────────────────────────────────
  'snippets/config/app-settings.js': {
    scopes: ['backend'], flags: ['app-settings'],
    description: 'Per-user application settings CRUD (Express + Postgres).',
  },
  'snippets/config/app-settings.py': {
    scopes: ['backend'], flags: ['app-settings'],
    description: 'Per-user application settings CRUD (FastAPI + Postgres).',
  },
  'snippets/config/app-settings-schema.sql': {
    scopes: ['database'], flags: ['app-settings'],
    description: 'SQL schema for per-user application settings.',
  },
  'snippets/config/AppSettings.jsx': {
    scopes: ['frontend'], flags: ['app-settings'],
    description: 'React settings page component.',
  },
  'snippets/config/cors-proxy.js': {
    scopes: ['backend'], flags: ['cors-proxy'],
    description: 'Express CORS-safe proxy for external APIs the frontend cannot call directly.',
  },
  'snippets/config/cors-middleware.py': {
    scopes: ['backend'], flags: ['cors-proxy'],
    description: 'FastAPI CORS middleware.',
  },

  // ─── snippets/connections/ ──────────────────────────────────────────
  'snippets/connections/internal-llm.js': {
    scopes: ['backend'], flags: ['ai-chat', 'ai-rag'],
    description: 'Internal LLM API client (corp gateway). Use for ai-chat and ai-rag flows.',
  },
  'snippets/connections/brave-search.js': {
    scopes: ['backend'], flags: ['search-external'],
    description: 'Brave Search API integration.',
  },
  'snippets/connections/snowflake.js': {
    scopes: ['backend'], flags: ['snowflake'],
    description: 'Snowflake data warehouse connection.',
  },
  'snippets/connections/sharepoint.js': {
    scopes: ['backend'], flags: ['sharepoint'],
    description: 'SharePoint API client for document library access.',
  },

  // ─── snippets/database/ ─────────────────────────────────────────────
  // Dockerfile.postgres is skipped by the parser
  // (dot-extension Dockerfiles don't carry frontmatter) but remains
  // fetchable via get_snippet directly.
  'snippets/database/migration-runner.js': {
    scopes: ['backend'], flags: [],
    description: 'Numbered SQL migration runner for post-deploy schema changes.',
  },

  // ─── snippets/email/ ────────────────────────────────────────────────
  'snippets/email/smtp-client.js': {
    scopes: ['backend'], flags: ['notifications-email'],
    description: 'SMTP client for sending transactional email via the corp relay.',
  },
  'snippets/email/smtp-client.py': {
    scopes: ['backend'], flags: ['notifications-email'],
    description: 'SMTP client (Python) for transactional email.',
  },

  // ─── snippets/file-handling/ ────────────────────────────────────────
  'snippets/file-handling/upload-handler.js': {
    scopes: ['backend'], flags: ['file-uploads'],
    description: 'Multer upload handler with memory storage and size limits.',
  },
  'snippets/file-handling/upload-handler.py': {
    scopes: ['backend'], flags: ['file-uploads'],
    description: 'FastAPI/Flask upload handler.',
  },
  'snippets/file-handling/document-text-extractor.js': {
    scopes: ['backend'], flags: ['file-uploads', 'ai-rag'],
    description: 'Extract text from uploaded PDF/DOCX/XLSX documents.',
  },
  'snippets/file-handling/document-text-extractor.py': {
    scopes: ['backend'], flags: ['file-uploads', 'ai-rag'],
    description: 'Python document text extractor for PDF/DOCX/XLSX.',
  },

  // ─── snippets/frontend/ ─────────────────────────────────────────────
  'snippets/frontend/AppScaffold.jsx': {
    scopes: ['frontend'], flags: [],
    description: 'App.jsx + main.jsx + index.html scaffold with React Router.',
  },
  'snippets/frontend/SearchPage.jsx': {
    scopes: ['frontend'], flags: ['search-ui', 'search-external'],
    description: 'Search page with input, fetch, results list, loading/empty/error states.',
  },
  'snippets/frontend/AdminPage.jsx': {
    scopes: ['frontend'], flags: ['has-admin'],
    description: 'Admin page with tabs, upload form, CRUD item list.',
  },
  'snippets/frontend/react-base-styles.css': {
    scopes: ['frontend'], flags: [],
    description: 'Base CSS variables, form/button/card styles, responsive layout.',
  },
  'snippets/frontend/vite-react-config.js': {
    scopes: ['frontend'], flags: [],
    description: 'vite.config.js + package.json baseline for React+Vite.',
  },
  // Dockerfile.react is skipped by the parser (dot-extension Dockerfiles
  // don't carry frontmatter) but remains fetchable via get_snippet directly.
  'snippets/frontend/nginx-production.conf': {
    scopes: ['frontend'], flags: [],
    description: 'Production nginx.conf with security headers and caching, no proxy_pass.',
  },
  'snippets/frontend/nginx-local-proxy.conf': {
    scopes: ['frontend'], flags: [],
    description: 'Local dev nginx.conf with /api and /socket.io proxy blocks.',
  },

  // ─── snippets/integration/ ──────────────────────────────────────────
  'snippets/integration/docker-compose-fullstack.yml': {
    scopes: ['integration'], flags: [],
    description: 'Full-stack docker-compose (frontend + backend + PostgreSQL).',
  },
  'snippets/integration/docker-compose-mysql.yml': {
    scopes: ['integration'], flags: [],
    description: 'docker-compose with MySQL instead of PostgreSQL.',
  },
  'snippets/integration/docker-compose-vectordb.yml': {
    scopes: ['integration'], flags: ['ai-rag'],
    description: 'docker-compose adding a vector DB service for RAG.',
  },
  'snippets/integration/docker-compose-frontend-only.yml': {
    scopes: ['integration'], flags: [],
    description: 'docker-compose for frontend-only apps (no backend/db).',
  },

  // ─── snippets/llm/ ──────────────────────────────────────────────────
  'snippets/llm/bayer-llm-client.js': {
    scopes: ['backend'], flags: ['ai-chat', 'ai-rag'],
    description: 'Direct chat completion client against the corp LLM gateway.',
  },
  'snippets/llm/bayer-llm-client.py': {
    scopes: ['backend'], flags: ['ai-chat', 'ai-rag'],
    description: 'Python client for corp LLM chat completions.',
  },
  'snippets/llm/mga-assistant-client.js': {
    scopes: ['backend'], flags: ['ai-chat'],
    description: 'Bayer MGA assistant client — use when a pre-configured assistant orchestrates the flow.',
  },
  'snippets/llm/mga-assistant-client.py': {
    scopes: ['backend'], flags: ['ai-chat'],
    description: 'Python client for Bayer MGA assistants.',
  },

  // ─── snippets/realtime/ ─────────────────────────────────────────────
  'snippets/realtime/websocket-helper.js': {
    scopes: ['backend'], flags: ['real-time'],
    description: 'WebSocket helper for broadcasting events to connected clients.',
  },
  'snippets/realtime/websocket-helper.py': {
    scopes: ['backend'], flags: ['real-time'],
    description: 'Python WebSocket broadcast helper.',
  },

  // ─── snippets/security/ ─────────────────────────────────────────────
  'snippets/security/input-validation.js': {
    scopes: ['backend'], flags: [],
    description: 'Server-side input validation patterns (length, type, required).',
  },
  'snippets/security/input-validation.py': {
    scopes: ['backend'], flags: [],
    description: 'Python input validation patterns.',
  },
  'snippets/security/parameterized-queries.js': {
    scopes: ['backend'], flags: [],
    description: 'Safe parameterised SQL patterns (no string concat).',
  },
  'snippets/security/parameterized-queries.py': {
    scopes: ['backend'], flags: [],
    description: 'Python parameterised SQL patterns (asyncpg / psycopg).',
  },
  'snippets/security/sanitize-middleware.js': {
    scopes: ['backend'], flags: [],
    description: 'HTML/XSS sanitisation middleware.',
  },
  'snippets/security/sanitize-middleware.py': {
    scopes: ['backend'], flags: [],
    description: 'Python HTML/XSS sanitisation middleware.',
  },

  // ─── snippets/sharepoint/ ───────────────────────────────────────────
  'snippets/sharepoint/sharepoint-client.js': {
    scopes: ['backend'], flags: ['sharepoint'],
    description: 'SharePoint document library client.',
  },
  'snippets/sharepoint/sharepoint-client.py': {
    scopes: ['backend'], flags: ['sharepoint'],
    description: 'Python SharePoint client.',
  },

  // ─── snippets/ui/ ───────────────────────────────────────────────────
  'snippets/ui/datepicker-react.jsx': {
    scopes: ['frontend'], flags: [],
    description: 'React date picker component.',
  },
};

// ── Frontmatter rendering ──

function renderMd({ scopes, flags, description }) {
  return (
    '---\n' +
    `scopes: [${scopes.join(', ')}]\n` +
    `flags: [${flags.join(', ')}]\n` +
    (description ? `description: ${description}\n` : '') +
    '---\n\n'
  );
}

function renderJsdoc({ scopes, flags, description }) {
  return (
    '/**\n' +
    ` * scopes: [${scopes.join(', ')}]\n` +
    ` * flags: [${flags.join(', ')}]\n` +
    (description ? ` * description: ${description}\n` : '') +
    ' */\n\n'
  );
}

function renderPyDoc({ scopes, flags, description }) {
  return (
    '"""\n' +
    `scopes: [${scopes.join(', ')}]\n` +
    `flags: [${flags.join(', ')}]\n` +
    (description ? `description: ${description}\n` : '') +
    '"""\n\n'
  );
}

function renderHashComment({ scopes, flags, description }) {
  return (
    `# scopes: [${scopes.join(', ')}]\n` +
    `# flags: [${flags.join(', ')}]\n` +
    (description ? `# description: ${description}\n` : '') +
    '\n'
  );
}

function renderDashComment({ scopes, flags, description }) {
  return (
    `-- scopes: [${scopes.join(', ')}]\n` +
    `-- flags: [${flags.join(', ')}]\n` +
    (description ? `-- description: ${description}\n` : '') +
    '\n'
  );
}

function renderCss({ scopes, flags, description }) {
  return (
    '/**\n' +
    ` * scopes: [${scopes.join(', ')}]\n` +
    ` * flags: [${flags.join(', ')}]\n` +
    (description ? ` * description: ${description}\n` : '') +
    ' */\n\n'
  );
}

function pickRenderer(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const name = path.basename(filePath);
  if (ext === '.md') return renderMd;
  if (['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.rs'].includes(ext)) return renderJsdoc;
  if (ext === '.py') return renderPyDoc;
  if (ext === '.css') return renderCss;
  if (['.yml', '.yaml', '.conf', '.sh'].includes(ext)) return renderHashComment;
  if (/^dockerfile(?:[-.].+)?$/i.test(name)) return renderHashComment;
  if (ext === '.sql') return renderDashComment;
  return null;
}

// ── Runner ──

const apply = process.argv.includes('--apply');

let tagged = 0, skipped = 0, noTool = 0, missing = 0, alreadyTagged = 0;

for (const [rel, spec] of Object.entries(TAGS)) {
  if (spec === null) { skipped++; continue; }

  const abs = path.join(REPO_ROOT, rel);
  if (!existsSync(abs)) {
    console.error(`[tag-files] missing: ${rel}`);
    missing++;
    continue;
  }

  const render = pickRenderer(rel);
  if (!render) {
    console.error(`[tag-files] no fence for ${rel}`);
    noTool++;
    continue;
  }

  const existing = parseFrontmatter(abs);
  if (existing._present) {
    alreadyTagged++;
    continue;
  }

  const header = render(spec);
  const content = readFileSync(abs, 'utf-8');
  const next = header + content;

  if (apply) {
    writeFileSync(abs, next);
    console.error(`[tag-files] tagged ${rel}`);
  } else {
    console.log(`--- PROPOSED: ${rel} ---`);
    console.log(header.split('\n').slice(0, 6).join('\n'));
  }
  tagged++;
}

console.error('');
console.error(`[tag-files] ${apply ? 'applied' : 'dry-run'}: tagged=${tagged} already=${alreadyTagged} skipped=${skipped} no-fence=${noTool} missing=${missing}`);
process.exit(0);
