/**
 * Canonical flag catalog. Single source of truth.
 *
 * Consumed by:
 *   - lint-frontmatter.js       — validates that snippet/rule `flags:`
 *                                 headers only use names listed here.
 *   - sync-router-prompt.js     — regenerates FLAG CATALOG and smart-budget
 *                                 checklist sections of chat/prompts/router.md.
 *   - resolve_context MCP tool  — does not read this module directly (it
 *                                 reads frontmatter), but tool callers should
 *                                 only emit flag names listed here.
 *
 * Every entry has:
 *   description      — one-line summary shown to the router.
 *   checklist        — dimensions the router must resolve with the user
 *                      before producing an execute plan. When the flag is
 *                      active and any dimension is unresolved, the router
 *                      should ask one clarifying question about the most
 *                      valuable unresolved dimension.
 *   inferenceSignals — words and phrases in the user's wording that strongly
 *                      suggest this flag. Used by the router for
 *                      assistant-picked extras (inference + confirm, not
 *                      a multi-select menu).
 */

export const KNOWN_FLAGS = {
  'has-users': {
    description: 'Per-user data, login-gated features, OIDC user identity needed.',
    checklist: [
      'who can access the app (all authenticated users or a subset)',
      'what user data the app stores beyond identity (profile fields, preferences)',
      'whether user roles distinguish behaviour (employee vs manager vs admin)',
    ],
    inferenceSignals: [
      'my', 'user', 'users', 'team', 'login', 'sign in', 'account', 'profile',
      'personal', 'per-user', 'each person', 'me', 'employee', 'person',
    ],
  },

  'has-admin': {
    description: 'Admin view that can see or manage everyone\'s data; privileged operations.',
    checklist: [
      'what admin powers exist (override decisions, delete any record, view all data, rename)',
      'who counts as admin (named role, enumerated users, or a flag)',
      'whether an audit log of admin actions is needed',
    ],
    inferenceSignals: [
      'admin', 'manager', 'HR', 'moderator', 'override', 'approve',
      'manage everyone', 'see all', 'delete any', 'team lead',
    ],
  },

  'long-form-content': {
    description: 'Authored content like posts, articles, docs, wiki entries.',
    checklist: [
      'draft vs publish workflow (or direct publish)',
      'author attribution and edit history',
      'moderation or approval before publish',
    ],
    inferenceSignals: [
      'post', 'article', 'blog', 'wiki', 'doc', 'recipe', 'knowledge base',
      'write up', 'publish', 'draft', 'entry',
    ],
  },

  'search-ui': {
    description: 'In-app search over stored entities with filters and sort.',
    checklist: [
      'which entities are searchable',
      'filter and facet dimensions (date, status, tag, owner)',
      'sort options and default ordering',
    ],
    inferenceSignals: [
      'search', 'find', 'filter', 'look up', 'browse', 'facet', 'sort by',
    ],
  },

  'search-external': {
    description: 'Outbound calls to external search APIs (Brave, web, document APIs).',
    checklist: [
      'which external API provides results',
      'query shape and rate limits',
      'how results are cached or stored, if at all',
    ],
    inferenceSignals: [
      'Brave', 'web search', 'Google', 'external search', 'fetch from web',
      'internet search', 'scrape',
    ],
  },

  'real-time': {
    description: 'WebSocket push, live updates, presence, typing indicators.',
    checklist: [
      'what events are pushed (new items, edits, presence, typing)',
      'broadcast to everyone or per-user / per-room targeting',
      'whether presence / who-is-online is needed',
    ],
    inferenceSignals: [
      'real time', 'live', 'push', 'presence', 'typing indicator', 'socket',
      'who is online', 'instant', 'as it happens',
    ],
  },

  'ai-rag': {
    description: 'Retrieval-augmented generation over ingested documents or data.',
    checklist: [
      'corpus source (uploaded files, SharePoint, Snowflake, scraped pages)',
      'refresh / ingestion cadence (one-off upload or ongoing sync)',
      'who can ingest new documents and who can query',
    ],
    inferenceSignals: [
      'RAG', 'search our docs', 'semantic search', 'ask my documents',
      'knowledge base AI', 'embeddings', 'vector search', 'similarity',
    ],
  },

  'ai-chat': {
    description: 'Conversational LLM chat without document retrieval.',
    checklist: [
      'persona / system instructions the assistant must follow',
      'session scope (per-user conversation history, ephemeral, or shared)',
      'whether conversation history is stored and for how long',
    ],
    inferenceSignals: [
      'chatbot', 'AI assistant', 'conversation', 'ask AI', 'chat with',
      'AI helper', 'virtual assistant',
    ],
  },

  'file-uploads': {
    description: 'Users upload files through the app (not to share with AI — that is ai-file-input).',
    checklist: [
      'max file size and allowed types',
      'storage mode (memory-only processing vs persistent in /data)',
      'who can upload and who can download',
    ],
    inferenceSignals: [
      'upload', 'attach', 'submit a file', 'drop in a file', 'upload a photo',
      'attach document',
    ],
  },

  'notifications-email': {
    description: 'SMTP email notifications triggered by app events.',
    checklist: [
      'what events trigger emails (approval, due date, status change)',
      'recipients (requester, approver, admin, everyone involved)',
      'templated HTML or plain text, and who writes the templates',
    ],
    inferenceSignals: [
      'email', 'notify', 'send a mail', 'alert by email', 'email when',
      'let me know', 'inform',
    ],
  },

  'exports-csv': {
    description: 'User-triggered CSV / tabular export of app data.',
    checklist: [
      'which entities and fields are exportable',
      'which filters or date ranges apply to the export',
      'who can export (any user, admin only, a role)',
    ],
    inferenceSignals: [
      'CSV', 'Excel', 'export', 'download as', 'report', 'spreadsheet',
    ],
  },

  sharepoint: {
    description: 'Reads or writes Bayer SharePoint document libraries.',
    checklist: [
      'which site or library the app needs access to',
      'read-only or read-write',
      'how often syncs happen',
    ],
    inferenceSignals: [
      'SharePoint', 'document library', 'corp docs', 'Teams site',
    ],
  },

  snowflake: {
    description: 'Queries a Snowflake warehouse for analytics or lookup.',
    checklist: [
      'which database, schema, and tables',
      'query shape (canned report, ad-hoc, aggregation)',
      'caching expectations for slow queries',
    ],
    inferenceSignals: [
      'Snowflake', 'data warehouse', 'warehouse query', 'analytics DB',
    ],
  },

  'app-settings': {
    description: 'In-app settings page for per-user or per-tenant preferences.',
    checklist: [
      'which settings exist and their types',
      'scope of settings (per-user, per-team, global)',
      'who can change them',
    ],
    inferenceSignals: [
      'settings page', 'preferences', 'configure', 'customise',
      'user settings', 'my preferences',
    ],
  },

  'cors-proxy': {
    description: 'Backend acts as a CORS-safe proxy for an external API the frontend needs.',
    checklist: [
      'target external API and auth method',
      'which endpoints the proxy exposes',
      'rate limiting and caching',
    ],
    inferenceSignals: [
      'CORS', 'proxy external API', 'call third-party API', 'browser blocked',
    ],
  },

  migration: {
    description: 'Porting existing code into this template instead of starting fresh.',
    checklist: [
      'source stack (frontend build tool, backend language, database)',
      'what to keep vs adapt',
      'any deployment artefacts to port',
    ],
    inferenceSignals: [
      'migrate', 'port', 'I have a', 'existing code', 'deploy my', 'move my app',
      'already built', 'existing project',
    ],
  },
};

/** Throws on unknown flag name. */
export function assertKnownFlag(name) {
  if (!Object.prototype.hasOwnProperty.call(KNOWN_FLAGS, name)) {
    throw new Error(`Unknown flag: "${name}". Known flags: ${Object.keys(KNOWN_FLAGS).sort().join(', ')}`);
  }
}

/** Returns true iff every flag name in the list is known. */
export function allKnown(flags) {
  return flags.every(f => Object.prototype.hasOwnProperty.call(KNOWN_FLAGS, f));
}

/** Sorted list of known flag names. */
export function knownFlagNames() {
  return Object.keys(KNOWN_FLAGS).sort();
}
