/**
 * Deterministic `file_structure` computation for the contracts contract
 * (Section A of HARNESS_EVOLUTION.md). Single source of truth for the
 * per-scope file/folder shape — read by:
 *
 *  - the pre-stage step (decides which Dockerfile/template to copy)
 *  - the reconciler / structural-checks.js (validates layout)
 *  - the contract-types-generator (W1.TYPES.GEN — knows where to write)
 *  - `checkPermissions` (W1.PATH — `forbidden_paths` denies wrong-language writes)
 *
 * The router does not emit this — it's derived deterministically from
 * `(tasks[], flags[], chosen language)` so we never have to validate router
 * output against a freeform "where do files go" schema.
 *
 * Canonical entry conventions post-Phase-0:
 *  - Node backend: `backend/src/index.ts` (TypeScript)
 *  - Python backend: `backend/main.py`
 *  - Frontend: `react-vite` only, entry `frontend/src/main.tsx`
 *  - Database: `postgres` only (MySQL deleted in W2.NARROW)
 *  - Vectordb: `pgvector` only (Chroma/Qdrant deleted in W2.NARROW)
 *
 * `forbidden_paths` catches the wrong-language-confusion failure mode: a
 * Node-backend dispatch writing `backend/main.py`, or a Python-backend
 * dispatch writing `backend/src/index.ts`. The permission gate (W1.PATH)
 * reads this and hard-denies.
 */

const VALID_BACKEND_LANGUAGES = new Set(['node', 'python']);

/**
 * @param {object} args
 * @param {Array<{ scope: string, language?: string }>} args.tasks
 *   The router-emitted tasks array. Only `scope` and optional `language` are
 *   read; everything else is ignored.
 * @param {Array<string>} [args.flags]
 *   Flag set from the router. Currently unused for layout decisions (the
 *   narrowed stack collapsed most flag-driven branches) but kept on the
 *   signature so future scope additions can read it without a signature
 *   migration.
 * @param {string} [args.backendLanguage]
 *   Override for backend language detection. When omitted, infers from the
 *   backend task's `language` field, falling back to `node`.
 * @returns {object} file_structure object — see HARNESS_EVOLUTION.md §A.
 */
export function computeFileStructure({ tasks = [], flags = [], backendLanguage } = {}) {
  const scopes = new Set((tasks || []).map(t => t?.scope).filter(Boolean));

  const backendTask = (tasks || []).find(t => t?.scope === 'backend');
  const resolvedLanguage = normalizeLanguage(backendLanguage || backendTask?.language || 'node');

  const result = {};

  if (scopes.has('backend')) {
    result.backend = buildBackendStructure(resolvedLanguage);
  }
  if (scopes.has('frontend')) {
    result.frontend = buildFrontendStructure();
  }
  if (scopes.has('database')) {
    result.database = buildDatabaseStructure();
  }
  if (scopes.has('vectordb')) {
    result.vectordb = buildVectordbStructure();
  }
  if (scopes.has('integration')) {
    result.integration = buildIntegrationStructure();
  }

  // `flags` reserved for future use — currently noop.
  void flags;

  return result;
}

function normalizeLanguage(lang) {
  const v = String(lang || '').toLowerCase();
  if (VALID_BACKEND_LANGUAGES.has(v)) return v;
  // Tolerant default: unrecognized values fall back to Node, which is the
  // post-Phase-0 default. Loud failures here would block builds for any
  // router emission that's slightly off-spec.
  return 'node';
}

function buildBackendStructure(language) {
  if (language === 'python') {
    return {
      language: 'python',
      entry: 'backend/main.py',
      required_files: [
        'backend/main.py',
        'backend/requirements.txt',
        'backend/Dockerfile',
      ],
      required_dirs: [
        'backend',
        'backend/generated',
      ],
      // The other-language entry is forbidden — catches dispatches that
      // confused which language was chosen mid-build.
      forbidden_paths: [
        'backend/src/index.ts',
        'backend/src/index.js',
      ],
    };
  }
  // node — canonical post-Phase-0 entry is .ts
  return {
    language: 'node',
    entry: 'backend/src/index.ts',
    required_files: [
      'backend/src/index.ts',
      'backend/package.json',
      'backend/Dockerfile',
    ],
    required_dirs: [
      'backend/src',
      'backend/src/generated',
    ],
    forbidden_paths: [
      'backend/main.py',
    ],
  };
}

function buildFrontendStructure() {
  return {
    framework: 'react-vite',
    required_files: [
      'frontend/src/main.tsx',
      'frontend/src/App.tsx',
      'frontend/package.json',
      'frontend/Dockerfile',
      'frontend/nginx.conf',
      'frontend/nginx.local.conf',
      'frontend/vite.config.ts',
    ],
    required_dirs: [
      'frontend/src',
      'frontend/src/generated',
    ],
  };
}

function buildDatabaseStructure() {
  return {
    engine: 'postgres',
    required_files: [
      'database/Dockerfile',
    ],
    required_dirs: [
      'database/init',
    ],
  };
}

function buildVectordbStructure() {
  return {
    engine: 'pgvector',
    required_files: [
      'vectordb/Dockerfile',
    ],
    required_dirs: [
      'vectordb/init',
    ],
  };
}

function buildIntegrationStructure() {
  return {
    required_files: [
      'docker-compose.yml',
      '.env.example',
    ],
  };
}
