/**
 * Contracts schema validator — W1.TYPES.GEN (HARNESS_EVOLUTION.md §O).
 *
 * Hand-written, dependency-light validator for the on-disk shape of
 * `<workspace>/.harness/contracts.json`. Used by the type generator
 * BEFORE it walks the contracts to emit TS / Pydantic: garbage in,
 * loud failure out (with a precise JSON-path so the orchestrator can
 * point the model at the exact field to fix).
 *
 * Why hand-written: Ajv / Zod would pull in a new dep for a fixed,
 * deterministic shape we own end-to-end. The schema lives in code so
 * the rules are reviewable as logic, not as a JSON blob. One place,
 * one source of truth, no transitive dependencies.
 *
 * Casing tolerance: the on-disk envelope today uses camelCase keys
 * (`dataModel`, `apiContract`, ...) because orchestration-stash writes
 * with that convention. The plan's narrative refers to snake_case
 * (`data_model`, `api_contract`, ...). This validator accepts either —
 * `getField` reads both — so the generator works against today's bytes
 * and against a future schema cleanup without churn.
 *
 * Return shape:
 *   { ok: true,  errors: [] }
 *   { ok: false, errors: [{ path: '.data.data_model.tables[2].columns[0].type', message: '...' }, ...] }
 *
 * The validator does NOT throw — it accumulates errors and lets the
 * caller decide whether to abort. `generateContractTypes` aborts on
 * any error; CLI dry-runs may want to keep going.
 */

/**
 * Look up a field by either of two key spellings (snake_case OR camelCase).
 * Returns `undefined` when neither is present. Does NOT distinguish
 * "absent" from "explicitly null" — callers decide whether null is OK
 * (vector_engine: null is a valid "no vectordb scope" signal).
 */
function getField(obj, snake, camel) {
  if (!obj || typeof obj !== 'object') return undefined;
  if (snake in obj) return obj[snake];
  if (camel && camel in obj) return obj[camel];
  return undefined;
}

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

// Plain SQL identifier — table/column names must match this because they are
// interpolated into a psql query in the live schema-drift check
// (session/docker-orchestration.js). Rejecting anything else at ingest keeps
// quotes/shell metacharacters out of that call.
const SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Validate the contracts envelope.
 *
 * @param {{ version?: number, data?: object } | null} envelope
 * @returns {{ ok: boolean, errors: Array<{ path: string, message: string }> }}
 */
export function validate(envelope) {
  const errors = [];

  if (envelope == null) {
    errors.push({ path: '', message: 'contracts envelope is null/undefined' });
    return { ok: false, errors };
  }
  if (!isPlainObject(envelope)) {
    errors.push({ path: '', message: `expected object, got ${typeof envelope}` });
    return { ok: false, errors };
  }

  // Top-level envelope: version + data
  if (typeof envelope.version !== 'number') {
    errors.push({ path: '.version', message: `expected number, got ${typeof envelope.version}` });
  } else if (envelope.version !== 1) {
    errors.push({ path: '.version', message: `unsupported version ${envelope.version}; expected 1` });
  }
  if (!isPlainObject(envelope.data)) {
    errors.push({ path: '.data', message: `expected object, got ${envelope.data === null ? 'null' : typeof envelope.data}` });
    // Without data we can't validate anything else.
    return { ok: errors.length === 0, errors };
  }

  const data = envelope.data;

  // data_model (optional — a backend-less app may not have tables)
  const dataModel = getField(data, 'data_model', 'dataModel');
  if (dataModel !== undefined && dataModel !== null) {
    validateDataModel(dataModel, '.data.data_model', errors);
  }

  // api_contract (optional)
  const apiContract = getField(data, 'api_contract', 'apiContract');
  if (apiContract !== undefined && apiContract !== null) {
    validateApiContract(apiContract, '.data.api_contract', errors);
  }

  // ui_contract (optional)
  const uiContract = getField(data, 'ui_contract', 'uiContract');
  if (uiContract !== undefined && uiContract !== null) {
    validateUiContract(uiContract, '.data.ui_contract', errors);
  }

  // business_logic_contract (optional — pure shape check, no required keys)
  const bizContract = getField(data, 'business_logic_contract', 'businessLogicContract');
  if (bizContract !== undefined && bizContract !== null && !isPlainObject(bizContract)) {
    errors.push({
      path: '.data.business_logic_contract',
      message: `expected object or null, got ${typeof bizContract}`,
    });
  }

  // vector_engine (optional — post-Phase-0 only 'pgvector' is allowed)
  const vectorEngine = getField(data, 'vector_engine', 'vectorEngine');
  if (vectorEngine !== undefined && vectorEngine !== null) {
    if (vectorEngine !== 'pgvector') {
      errors.push({
        path: '.data.vector_engine',
        message: `unsupported value '${vectorEngine}'; only 'pgvector' allowed post-Phase-0`,
      });
    }
  }

  // file_structure (required — at least one scope)
  const fileStructure = getField(data, 'file_structure', 'fileStructure');
  if (!isPlainObject(fileStructure)) {
    errors.push({
      path: '.data.file_structure',
      message: `expected object, got ${fileStructure === null ? 'null' : typeof fileStructure}`,
    });
  } else {
    validateFileStructure(fileStructure, '.data.file_structure', errors);
  }

  return { ok: errors.length === 0, errors };
}

function validateDataModel(dataModel, basePath, errors) {
  if (!isPlainObject(dataModel)) {
    errors.push({ path: basePath, message: `expected object, got ${typeof dataModel}` });
    return;
  }
  const tables = dataModel.tables;
  if (tables === undefined) return; // tables is optional; data_model can be empty shell
  if (!Array.isArray(tables)) {
    errors.push({ path: `${basePath}.tables`, message: `expected array, got ${typeof tables}` });
    return;
  }
  tables.forEach((table, i) => {
    const tPath = `${basePath}.tables[${i}]`;
    if (!isPlainObject(table)) {
      errors.push({ path: tPath, message: `expected object, got ${typeof table}` });
      return;
    }
    if (!isNonEmptyString(table.name)) {
      errors.push({ path: `${tPath}.name`, message: 'expected non-empty string' });
    } else if (!SQL_IDENTIFIER.test(table.name)) {
      // Table/column names reach a psql query (live schema-drift check) — reject
      // anything that isn't a plain SQL identifier so a name can never carry
      // quotes/shell metacharacters into that call.
      errors.push({ path: `${tPath}.name`, message: 'must be a valid SQL identifier ([A-Za-z_][A-Za-z0-9_]*)' });
    }
    if (!Array.isArray(table.columns)) {
      errors.push({ path: `${tPath}.columns`, message: `expected array, got ${typeof table.columns}` });
      return;
    }
    table.columns.forEach((col, j) => {
      const cPath = `${tPath}.columns[${j}]`;
      if (!isPlainObject(col)) {
        errors.push({ path: cPath, message: `expected object, got ${typeof col}` });
        return;
      }
      if (!isNonEmptyString(col.name)) {
        errors.push({ path: `${cPath}.name`, message: 'expected non-empty string' });
      } else if (!SQL_IDENTIFIER.test(col.name)) {
        errors.push({ path: `${cPath}.name`, message: 'must be a valid SQL identifier ([A-Za-z_][A-Za-z0-9_]*)' });
      }
      if (!isNonEmptyString(col.type)) {
        errors.push({ path: `${cPath}.type`, message: 'expected non-empty string' });
      }
    });
  });
}

function validateApiContract(apiContract, basePath, errors) {
  if (!isPlainObject(apiContract)) {
    errors.push({ path: basePath, message: `expected object, got ${typeof apiContract}` });
    return;
  }
  const endpoints = apiContract.endpoints;
  if (endpoints === undefined) return; // optional
  if (!Array.isArray(endpoints)) {
    errors.push({ path: `${basePath}.endpoints`, message: `expected array, got ${typeof endpoints}` });
    return;
  }
  endpoints.forEach((ep, i) => {
    const ePath = `${basePath}.endpoints[${i}]`;
    if (!isPlainObject(ep)) {
      errors.push({ path: ePath, message: `expected object, got ${typeof ep}` });
      return;
    }
    if (!isNonEmptyString(ep.method)) {
      errors.push({ path: `${ePath}.method`, message: 'expected non-empty string (GET/POST/etc.)' });
    }
    if (!isNonEmptyString(ep.path)) {
      errors.push({ path: `${ePath}.path`, message: 'expected non-empty string (URL path)' });
    }
    // response is optional today (some endpoints may not have shaped response
    // contracts), but if present must be an object with a body.
    if (ep.response !== undefined && ep.response !== null) {
      if (!isPlainObject(ep.response)) {
        errors.push({ path: `${ePath}.response`, message: `expected object, got ${typeof ep.response}` });
      }
      // status/body are convention but not strict — validator is permissive.
    }
    if (ep.request !== undefined && ep.request !== null && !isPlainObject(ep.request)) {
      errors.push({ path: `${ePath}.request`, message: `expected object or null, got ${typeof ep.request}` });
    }
    // allowed_roles — optional per-endpoint authz gate (roles permitted to
    // reach this route); when present must be an array of role-name strings.
    if (ep.allowed_roles !== undefined && ep.allowed_roles !== null
      && !(Array.isArray(ep.allowed_roles) && ep.allowed_roles.every((r) => typeof r === 'string'))) {
      errors.push({ path: `${ePath}.allowed_roles`, message: 'expected array of role-name strings' });
    }
  });
}

function validateUiContract(uiContract, basePath, errors) {
  if (!isPlainObject(uiContract)) {
    errors.push({ path: basePath, message: `expected object, got ${typeof uiContract}` });
    return;
  }
  const components = uiContract.components;
  if (components === undefined) return; // optional
  if (!Array.isArray(components)) {
    errors.push({ path: `${basePath}.components`, message: `expected array, got ${typeof components}` });
    return;
  }
  components.forEach((comp, i) => {
    const cPath = `${basePath}.components[${i}]`;
    if (!isPlainObject(comp)) {
      errors.push({ path: cPath, message: `expected object, got ${typeof comp}` });
      return;
    }
    if (!isNonEmptyString(comp.name)) {
      errors.push({ path: `${cPath}.name`, message: 'expected non-empty string' });
    }
    // role is conventional but tolerant — some components may have no role.
    if (comp.role !== undefined && comp.role !== null && typeof comp.role !== 'string') {
      errors.push({ path: `${cPath}.role`, message: 'expected string or null' });
    }
  });
}

function validateFileStructure(fileStructure, basePath, errors) {
  const ALLOWED_SCOPES = new Set(['backend', 'frontend', 'database', 'vectordb', 'integration']);
  const present = Object.keys(fileStructure).filter(k => ALLOWED_SCOPES.has(k));
  if (present.length === 0) {
    errors.push({
      path: basePath,
      message: 'file_structure must include at least one scope (backend/frontend/database/vectordb/integration)',
    });
    return;
  }
  for (const scope of present) {
    const node = fileStructure[scope];
    const sPath = `${basePath}.${scope}`;
    if (!isPlainObject(node)) {
      errors.push({ path: sPath, message: `expected object, got ${typeof node}` });
      continue;
    }
    // required_files + required_dirs are conventional but lenient — only
    // type-check when present.
    if (node.required_files !== undefined && !Array.isArray(node.required_files)) {
      errors.push({ path: `${sPath}.required_files`, message: `expected array, got ${typeof node.required_files}` });
    }
    if (node.required_dirs !== undefined && !Array.isArray(node.required_dirs)) {
      errors.push({ path: `${sPath}.required_dirs`, message: `expected array, got ${typeof node.required_dirs}` });
    }
  }
}
