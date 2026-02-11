import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { WORKSPACE_DIR } from '../paths.js';

const CLINERULES_DIR = path.join(WORKSPACE_DIR, '.clinerules');
const SNIPPETS_DIR = path.join(WORKSPACE_DIR, 'snippets');

// ── Document descriptions for embedding (multi-vector) ──
// Each file gets multiple description variants embedded separately.
// At query time we take Math.max() across all variants for each file.
// This captures different angles: topic, user intent, and keyword clusters.

const RULE_DOCS = [
  { file: '01-session-start.md', descriptions: [
    'Session initialization, environment detection, greeting returning user, reading project status',
    'Hi, hello, get started, first time, new session, check for updates',
  ]},
  { file: '02-welcome-modes.md', descriptions: [
    'Welcome message, beginner vs developer communication mode, experience level, onboarding style',
    'How should the AI talk to me, simple language, technical mode, change communication style',
  ]},
  { file: '03-project-setup.md', descriptions: [
    'Fresh project vs migrated existing code, verify project structure, missing Dockerfiles, health endpoints',
    'I already have code, import my existing project, migrate my app, check my project structure',
  ]},
  { file: '04-understanding.md', descriptions: [
    'Understand project idea, clarify requirements, choose technology stack, plan features, recommend frameworks',
    'I want to build something, describe my idea, what should the app do, help me plan, which technology to use',
    'I have an idea for an app, suggest a tech stack, what framework should I use',
  ]},
  { file: '05-building.md', descriptions: [
    'Build application features, create frontend backend API endpoints database, components routes UI pages',
    'Create something for me, make an app that does X, build a tool, develop a new feature, implement functionality',
    'Web scraping, crawling websites, fetch external data, data processing, automation, cron jobs, scheduled tasks, summarization, charts, dashboards, API integrations, notifications, email',
    'Monitor data, track changes, collect information, log events to CSV, sentiment analysis, research competitors, find and list items, aggregate reports',
  ]},
  { file: '06-testing.md', descriptions: [
    'Test application locally, docker-compose up, preview the app, run it, check if it works',
    'Let me try it, run my app, start the server, see the result, open in browser, does it work',
  ]},
  { file: '07-deployment.md', descriptions: [
    'Deploy to production, go live, push code, make app available publicly, launch, production URL',
    'Ship it, publish my app, make it live, put it online, deploy now, whitelisting, git push',
  ]},
  { file: '08-secrets.md', descriptions: [
    'API keys, secrets, environment variables, credentials, configuration, tokens, .env file, GitHub Secrets',
    'I need an API key, set up OpenAI key, store my database password, add credentials, configure third-party service',
  ]},
  { file: '09-troubleshooting.md', descriptions: [
    'Fix errors, debug problems, app not working, crash, broken, deployment failed, something went wrong',
    'It doesnt work, I see an error, white screen, loading forever, stuck, help me fix this, logs, investigate',
  ]},
  { file: '10-platform-rules.md', descriptions: [
    'Platform constraints, nginx config, port numbers, Docker requirements, API routing rules, infrastructure',
    'Folder structure, health endpoint, container setup, reverse proxy, how the platform works',
  ]},
  { file: '11-status-tracking.md', descriptions: [
    'Update project status document, track progress, completed tasks, session history',
    'What has been done so far, what is left to do, record my progress, project summary',
  ]},
  { file: '12-snippets.md', descriptions: [
    'Code snippet library, reuse existing code, pre-built templates, common patterns',
    'Do we have a snippet for that, dont write from scratch, use a template, existing code examples',
  ]},
  { file: '13-background-commands.md', descriptions: [
    'Background processes, docker detached mode, long-running commands, server running',
    'Keep the server running, hot reload, dev server, preflight checks, run in background',
  ]},
  { file: '14-file-handling.md', descriptions: [
    'File uploads downloads storage, persistent files, images documents PDFs, user files',
    'Users need to upload files, save files permanently, document library, file sharing, store at /data',
  ]},
  { file: '15-urls.md', descriptions: [
    'Application URLs, codespace URL, localhost, production URL, how to access the app',
    'Where is my app, what is the link, open the app, how do I access it, URL for my application',
  ]},
  { file: '16-ai-file-input.md', descriptions: [
    'User sharing files with AI, context folder, analyze documents, read my file',
    'I want to share a file with you, look at this document, analyze my PDF, use this as reference, upload requirements',
  ]},
  { file: '17-user-identity.md', descriptions: [
    'User authentication, login, SSO, OIDC identity, user profile, personalization',
    'Who is the logged in user, show user name, per-user data, know who is using the app, personalize',
  ]},
  { file: '18-security.md', descriptions: [
    'Security headers, input validation, SQL injection prevention, XSS protection, safe code',
    'Protect my app, sanitize input, non-root container, secrets management, secure my application',
  ]},
];

const SNIPPET_DOCS = [
  { file: 'auth/user-identity.js', descriptions: [
    'Get logged-in user identity from OIDC headers in Node.js Express, authentication',
    'Who is using the app, show the current user name, personalize for logged-in user',
  ]},
  { file: 'auth/user-identity.py', descriptions: [
    'Get logged-in user identity in Python FastAPI Flask, authentication headers',
    'Python user identity, who is using the app in Python',
  ]},
  { file: 'file-handling/upload-handler.js', descriptions: [
    'Handle file uploads from user, receive files, multer memory storage, multipart form data',
    'Users can attach files, upload documents, send files to the server',
  ]},
  { file: 'security/input-validation.js', descriptions: [
    'Validate and sanitize user input server-side, prevent injection, express-validator',
    'Clean form data, check user input, make sure input is safe',
  ]},
  { file: 'security/parameterized-queries.js', descriptions: [
    'Safe SQL database queries, prevent SQL injection, parameterized prepared statements',
    'Secure database access, safe way to query the database',
  ]},
];

// Rules that are ALWAYS included regardless of similarity score
const ALWAYS_INCLUDE_RULES = ['10-platform-rules.md', '18-security.md'];

// ── Embedding state ──
let embedder = null;
let ruleEmbeddings = []; // [{ file, descriptions, embeddings: [vec, vec, ...] }]
let snippetEmbeddings = []; // [{ file, descriptions, embeddings: [vec, vec, ...] }]
let initialized = false;

/**
 * Initialize the embedding model and pre-compute document embeddings.
 * Call this once at server startup.
 */
export async function initEmbeddings() {
  if (initialized) return;

  console.log('[middleware] Loading embedding model (all-MiniLM-L6-v2)...');
  const startTime = Date.now();

  try {
    const { pipeline } = await import('@huggingface/transformers');
    embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
      dtype: 'fp32',
    });

    console.log('[middleware] Model loaded in %dms. Computing document embeddings...', Date.now() - startTime);

    let totalVectors = 0;

    // Pre-compute rule embeddings (multiple vectors per rule)
    for (const doc of RULE_DOCS) {
      const embeddings = [];
      for (const desc of doc.descriptions) {
        embeddings.push(await embed(desc));
      }
      ruleEmbeddings.push({ file: doc.file, descriptions: doc.descriptions, embeddings });
      totalVectors += embeddings.length;
    }

    // Pre-compute snippet embeddings (multiple vectors per snippet)
    for (const doc of SNIPPET_DOCS) {
      if (existsSync(path.join(SNIPPETS_DIR, doc.file))) {
        const embeddings = [];
        for (const desc of doc.descriptions) {
          embeddings.push(await embed(desc));
        }
        snippetEmbeddings.push({ file: doc.file, descriptions: doc.descriptions, embeddings });
        totalVectors += embeddings.length;
      }
    }

    initialized = true;
    console.log('[middleware] Embeddings ready: %d rules, %d snippets, %d vectors (%dms total)',
      ruleEmbeddings.length, snippetEmbeddings.length, totalVectors, Date.now() - startTime);
  } catch (err) {
    console.error('[middleware] Failed to load embedding model:', err.message);
    console.error('[middleware] Falling back to keyword matching');
    initialized = true; // Mark as initialized so we don't retry
    embedder = null;
  }
}

/**
 * Embed a text string into a vector.
 */
async function embed(text) {
  if (!embedder) return null;
  const output = await embedder(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

/**
 * Cosine similarity between two vectors.
 */
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Score a query against a multi-vector document.
 * Returns the MAX similarity across all description variants.
 */
function maxSimilarity(queryEmbedding, docEmbeddings) {
  let best = 0;
  for (const emb of docEmbeddings) {
    const sim = cosineSimilarity(queryEmbedding, emb);
    if (sim > best) best = sim;
  }
  return best;
}

/**
 * Select relevant .clinerules files and code snippets for a user message.
 * Uses semantic embeddings if available, falls back to simple keyword matching.
 */
export async function selectContext(userMessage) {
  if (embedder) {
    return selectContextEmbedding(userMessage);
  }
  return selectContextFallback(userMessage);
}

/**
 * Embedding-based context selection (multi-vector).
 */
async function selectContextEmbedding(userMessage) {
  const startTime = Date.now();
  const queryEmbedding = await embed(userMessage);

  // Score rules by max similarity across all description variants
  const ruleScores = ruleEmbeddings.map(r => ({
    file: r.file,
    score: maxSimilarity(queryEmbedding, r.embeddings),
  }));

  // Take top 3 by score
  const topRules = ruleScores
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .filter(r => r.score > 0.15) // minimum threshold
    .map(r => r.file);

  // Merge with always-included, deduplicate
  const selectedRules = [...new Set([...ALWAYS_INCLUDE_RULES, ...topRules])];

  // Score snippets by max similarity
  const snippetScores = snippetEmbeddings.map(s => ({
    file: s.file,
    score: maxSimilarity(queryEmbedding, s.embeddings),
  }));

  const selectedSnippets = snippetScores
    .filter(s => s.score > 0.3) // higher threshold for snippets
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .map(s => s.file);

  // Read file contents
  const rulesContent = readRuleFiles(selectedRules);
  const snippetsContent = readSnippetFiles(selectedSnippets);

  console.log('[middleware] Context selected in %dms: rules=[%s] snippets=[%s]',
    Date.now() - startTime, selectedRules.join(', '), selectedSnippets.join(', ') || 'none');

  return { rules: selectedRules, rulesContent, snippets: selectedSnippets, snippetsContent };
}

/**
 * Fallback: simple keyword matching when embedding model isn't available.
 */
function selectContextFallback(userMessage) {
  const msg = userMessage.toLowerCase();

  const KEYWORD_MAP = [
    { file: '05-building.md', keywords: ['build', 'create', 'add', 'feature', 'component', 'page', 'frontend', 'backend', 'api', 'endpoint', 'database', 'route', 'crawl', 'scrape', 'fetch', 'automat'] },
    { file: '06-testing.md', keywords: ['test', 'run', 'docker', 'start', 'preview', 'localhost', 'try'] },
    { file: '07-deployment.md', keywords: ['deploy', 'push', 'live', 'production', 'publish', 'ship'] },
    { file: '08-secrets.md', keywords: ['api key', 'secret', 'env', 'openai', 'credential', 'token'] },
    { file: '09-troubleshooting.md', keywords: ['error', 'broken', 'not working', 'fix', 'bug', 'issue', 'fail', 'crash'] },
    { file: '14-file-handling.md', keywords: ['file', 'upload', 'download', 'storage', 'image', 'pdf'] },
    { file: '17-user-identity.md', keywords: ['user', 'login', 'auth', 'identity', 'sso', 'who'] },
  ];

  const scores = KEYWORD_MAP.map(entry => ({
    file: entry.file,
    score: entry.keywords.filter(kw => msg.includes(kw)).length,
  }));

  const topRules = scores
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(s => s.file);

  const selectedRules = [...new Set([...ALWAYS_INCLUDE_RULES, ...topRules])];
  const rulesContent = readRuleFiles(selectedRules);

  // Basic snippet matching
  const SNIPPET_KEYWORDS = [
    { keywords: ['upload', 'file', 'attach'], files: ['file-handling/upload-handler.js'] },
    { keywords: ['login', 'auth', 'identity', 'user'], files: ['auth/user-identity.js'] },
    { keywords: ['security', 'validate', 'injection', 'sql'], files: ['security/input-validation.js', 'security/parameterized-queries.js'] },
  ];

  const selectedSnippets = [];
  for (const entry of SNIPPET_KEYWORDS) {
    if (entry.keywords.some(kw => msg.includes(kw))) {
      selectedSnippets.push(...entry.files);
    }
  }
  const uniqueSnippets = [...new Set(selectedSnippets)].slice(0, 4);
  const snippetsContent = readSnippetFiles(uniqueSnippets);

  console.log('[middleware] Context selected (fallback): rules=[%s] snippets=[%s]',
    selectedRules.join(', '), uniqueSnippets.join(', ') || 'none');

  return { rules: selectedRules, rulesContent, snippets: uniqueSnippets, snippetsContent };
}

/**
 * Debug version: returns similarity scores for all rules and snippets.
 * Shows per-variant scores and which variant matched best.
 */
export async function debugSelectContext(userMessage) {
  if (!embedder) {
    const result = selectContextFallback(userMessage);
    return {
      mode: 'keyword-fallback',
      selectedRules: result.rules,
      selectedSnippets: result.snippets,
      ruleScores: [],
      snippetScores: [],
    };
  }

  const queryEmbedding = await embed(userMessage);

  const ruleScores = ruleEmbeddings.map(r => {
    // Score each variant
    const variantScores = r.embeddings.map((emb, i) => ({
      variant: r.descriptions[i],
      score: Math.round(cosineSimilarity(queryEmbedding, emb) * 1000) / 1000,
    }));
    const bestVariant = variantScores.reduce((a, b) => a.score > b.score ? a : b);
    return {
      file: r.file,
      score: bestVariant.score,
      bestMatch: bestVariant.variant,
      variants: variantScores,
    };
  }).sort((a, b) => b.score - a.score);

  const snippetScores = snippetEmbeddings.map(s => {
    const variantScores = s.embeddings.map((emb, i) => ({
      variant: s.descriptions[i],
      score: Math.round(cosineSimilarity(queryEmbedding, emb) * 1000) / 1000,
    }));
    const bestVariant = variantScores.reduce((a, b) => a.score > b.score ? a : b);
    return {
      file: s.file,
      score: bestVariant.score,
      bestMatch: bestVariant.variant,
      variants: variantScores,
    };
  }).sort((a, b) => b.score - a.score);

  // Replicate the selection logic
  const topRules = ruleScores.slice(0, 3).filter(r => r.score > 0.15).map(r => r.file);
  const selectedRules = [...new Set([...ALWAYS_INCLUDE_RULES, ...topRules])];
  const selectedSnippets = snippetScores.filter(s => s.score > 0.3).slice(0, 4).map(s => s.file);

  return {
    mode: 'multi-vector-embeddings',
    query: userMessage,
    selectedRules,
    selectedSnippets,
    alwaysIncluded: ALWAYS_INCLUDE_RULES,
    ruleScores,
    snippetScores,
  };
}

// ── File reading helpers ──

function readRuleFiles(files) {
  const contents = {};
  for (const file of files) {
    const filePath = path.join(CLINERULES_DIR, file);
    if (existsSync(filePath)) {
      try {
        contents[file] = readFileSync(filePath, 'utf-8');
      } catch { /* skip unreadable */ }
    }
  }
  return contents;
}

function readSnippetFiles(files) {
  const contents = {};
  for (const file of files) {
    const filePath = path.join(SNIPPETS_DIR, file);
    if (existsSync(filePath)) {
      try {
        contents[file] = readFileSync(filePath, 'utf-8');
      } catch { /* skip unreadable */ }
    }
  }
  return contents;
}
