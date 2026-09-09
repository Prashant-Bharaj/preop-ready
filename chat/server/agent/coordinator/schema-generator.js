/**
 * schema-generator.js — emits a complete `database/init/01_schema.sql` from
 * the contract's `data_model.tables[]` + (optionally) `vector_engine`.
 *
 * The generator is intentionally exhaustive — it produces the FULL schema
 * the contract describes, with column types verbatim from `data_model`,
 * FK references inferred from the column type strings (REFERENCES <table>(id)),
 * and conventional indexes on FK columns + descending indexes on created_at.
 *
 * When `vector_engine === 'pgvector'`:
 *   - prepends `CREATE EXTENSION IF NOT EXISTS vector;`
 *   - emits HNSW indexes on every `VECTOR(N)` column using vector_cosine_ops
 *
 * This eliminates the database subagent's discretion entirely. The subagent's
 * job collapses to: emit the Dockerfile (copy_template) + maybe seed data.
 */

const REFERENCES_RE = /REFERENCES\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/i;
const VECTOR_RE = /^\s*VECTOR\s*\(\s*(\d+)\s*\)/i;
const ON_DELETE_RE = /ON\s+DELETE\s+(CASCADE|SET\s+NULL|RESTRICT|NO\s+ACTION)/i;

export function generateSchema(contract) {
  let tables = contract?.dataModel?.tables || contract?.data_model?.tables || [];
  let vectorEngine = contract?.vectorEngine || contract?.vector_engine || null;
  if (!Array.isArray(tables) || tables.length === 0) return null;

  // Two-instance split: when the plan includes a dedicated vectordb service,
  // VECTOR(N) tables belong THERE (vectordb-scaffold-generator emits them
  // into vectordb/init) — not in the relational database, whose image has
  // no pgvector extension. Without this filter a declared chunks table
  // would crash database init on CREATE EXTENSION/VECTOR type.
  const hasVectordbScope = Array.isArray(contract?.tasks)
    && contract.tasks.some((t) => t && t.scope === 'vectordb');
  if (hasVectordbScope) {
    tables = tables.filter((t) => !(t.columns || []).some((c) => VECTOR_RE.test(String(c.type || ''))));
    vectorEngine = null; // no vector columns remain → no extension line
    if (tables.length === 0) return null;
  }

  const lines = [];
  lines.push(`-- AUTO-GENERATED — DO NOT EDIT — emitted from data_model + vector_engine`);
  lines.push(`-- Generated ${new Date().toISOString()}`);
  lines.push(`-- Tables: ${tables.map(t => t.name).join(', ')}`);
  lines.push('');

  if (vectorEngine === 'pgvector') {
    lines.push(`CREATE EXTENSION IF NOT EXISTS vector;`);
    lines.push('');
  }

  // Order tables so referenced tables come first (best-effort topological sort)
  const ordered = topologicalSort(tables);

  for (const table of ordered) {
    emitTable(table, lines);
    lines.push('');
  }

  // Conventional indexes: FK columns, created_at DESC, vector HNSW
  for (const table of ordered) {
    emitIndexes(table, lines);
  }

  return { source: lines.join('\n'), tableNames: ordered.map(t => t.name) };
}

export function emitTable(table, lines) {
  lines.push(`CREATE TABLE IF NOT EXISTS ${table.name} (`);
  const colLines = (table.columns || []).map(c => `  ${c.name} ${c.type}`);
  lines.push(colLines.join(',\n'));
  lines.push(`);`);
}

export function emitIndexes(table, lines) {
  for (const col of table.columns || []) {
    const type = String(col.type || '');

    // FK columns get a secondary index (PRIMARY KEY already indexed by definition)
    if (REFERENCES_RE.test(type) && !/PRIMARY\s+KEY/i.test(type)) {
      const idxName = `${table.name}_${col.name}_idx`;
      lines.push(`CREATE INDEX IF NOT EXISTS ${idxName} ON ${table.name} (${col.name});`);
    }

    // created_at convention — descending for "newest first" history queries
    if (col.name === 'created_at') {
      const idxName = `${table.name}_${col.name}_desc_idx`;
      lines.push(`CREATE INDEX IF NOT EXISTS ${idxName} ON ${table.name} (${col.name} DESC);`);
    }

    // VECTOR column → HNSW with cosine ops
    if (VECTOR_RE.test(type)) {
      const idxName = `${table.name}_${col.name}_hnsw_idx`;
      lines.push(`CREATE INDEX IF NOT EXISTS ${idxName} ON ${table.name} USING hnsw (${col.name} vector_cosine_ops);`);
    }
  }
}

/**
 * Topological sort by FK references — a table that REFERENCES X must come
 * after X in the emitted SQL. Falls back to original order on cycles.
 */
export function topologicalSort(tables) {
  const byName = new Map(tables.map(t => [t.name, t]));
  const deps = new Map(tables.map(t => [t.name, new Set()]));
  for (const t of tables) {
    for (const c of (t.columns || [])) {
      const m = REFERENCES_RE.exec(String(c.type || ''));
      if (m && byName.has(m[1]) && m[1] !== t.name) {
        deps.get(t.name).add(m[1]);
      }
    }
  }
  const visited = new Set();
  const out = [];
  function visit(name, stack) {
    if (visited.has(name)) return;
    if (stack.has(name)) return; // cycle — skip
    stack.add(name);
    for (const dep of deps.get(name) || []) visit(dep, stack);
    stack.delete(name);
    visited.add(name);
    out.push(byName.get(name));
  }
  for (const t of tables) visit(t.name, new Set());
  return out;
}
