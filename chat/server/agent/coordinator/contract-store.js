/**
 * contract-store.js — single merge path for the contract envelope.
 *
 * The envelope (`.harness/contracts.json`) is the app's persistent memory:
 * every gate, probe, type generator, and spawn message derives from it. A
 * stale envelope makes those defenses blind — observed live when an iterate
 * added a Prompt Templates page whose ui_contract diff was never merged, so
 * a later full-rewrite fix faithfully rebuilt the pre-iterate app and
 * dropped the page.
 *
 * Rules:
 *   - ALL contract-diff merging goes through mergeContractDiffs. No caller
 *     upserts endpoints/views/tables by hand.
 *   - A diff UPSERTS (add/change verbs) or RETIRES (remove_* verbs). Removal
 *     is explicit-only: it happens solely when a well-formed remove_* entry
 *     names an existing item by its exact merge key. A partial, confused, or
 *     absent diff never deletes anything:
 *       - a remove key with no envelope match is a loud no-op
 *       - a key present in both an add/change list and a remove list in the
 *         same diff keeps the item (removal skipped, loudly)
 *       - tables/columns are never removable (data loss; the live schema-
 *         drift check would go blind while the real table persists)
 *   - Every persisted merge appends to `data.revisions` so contract drift is
 *     traceable per iterate; removals appear as `-N` arms in the kinds.
 *
 * Merge keys per kind (removal matches the same key):
 *   api_contract.endpoints        by method+path (remove_endpoints)
 *   ui_contract.components        by name (remove_components)
 *   ui_contract.secondary_views   string union (remove_views)
 *   ui_contract.primary_view/_action  replace when provided
 *   data_model.tables             by name; columns within a table by name
 *   business_logic_contract.triggers  by event (remove_triggers)
 *   business_logic_contract.rules/side_effects  union (string or JSON identity;
 *     remove_rules/remove_side_effects by the same identity)
 *   business_logic_contract.llmIntegration/llmApiSpec/contentSchema  replace
 *   vector_engine                 replace when provided
 */

import { readContracts, writeContracts } from '../../session/harness-state.js';
import { invalidateContractsCache } from '../tools/util/check-permissions.js';
import { tlog } from '../../util/timestamped-log.js';

const MAX_REVISIONS = 50;

function upsertBy(list, items, keyOf, { mergeItem = false } = {}) {
  const out = Array.isArray(list) ? [...list] : [];
  let added = 0, replaced = 0;
  for (const item of Array.isArray(items) ? items : []) {
    const key = keyOf(item);
    if (key == null) continue;
    const idx = out.findIndex((x) => x != null && keyOf(x) === key);
    if (idx === -1) { out.push(item); added++; }
    else { out[idx] = mergeItem ? { ...out[idx], ...item } : item; replaced++; }
  }
  return { out, added, replaced };
}

/**
 * Remove items from a list by exact merge key. Mirrors upsertBy but never
 * deletes on ambiguity: an unmatched key is a loud no-op, and a key that the
 * same diff also adds/changes (skipKeys) keeps the item — a confused diff
 * never deletes.
 */
function removeBy(list, keys, keyOf, { skipKeys, label } = {}) {
  const out = Array.isArray(list) ? [...list] : [];
  let removed = 0;
  for (const key of Array.isArray(keys) ? keys : []) {
    if (key == null) continue;
    if (skipKeys && skipKeys.has(key)) {
      tlog('[contract-store] %s: %s appears in both an add/change list and a remove list — removal skipped', label, key);
      continue;
    }
    const idx = out.findIndex((x) => x != null && keyOf(x) === key);
    if (idx === -1) {
      tlog('[contract-store] %s: %s not in envelope — skipped', label, key);
      continue;
    }
    out.splice(idx, 1);
    removed++;
    tlog('[contract-store] %s: retired %s', label, key);
  }
  return { out, removed };
}

/**
 * Canonical removal keys for remove_endpoints entries. Accepts
 * { method, path } objects or "METHOD /path" strings; method is uppercased
 * and a leading /api prefix is stripped (the contract convention — Traefik
 * strips it, same normalization adoption applies). Malformed entries drop.
 */
function endpointRemovalKeys(raw) {
  const out = [];
  for (const r of Array.isArray(raw) ? raw : []) {
    let method, p;
    if (typeof r === 'string') {
      const i = r.indexOf(' ');
      if (i < 1) continue;
      method = r.slice(0, i);
      p = r.slice(i + 1).trim();
    } else if (r && typeof r.method === 'string' && typeof r.path === 'string') {
      method = r.method;
      p = r.path;
    } else continue;
    if (!p) continue;
    out.push(`${method.toUpperCase()} ${p.replace(/^\/api(?=\/)/, '')}`);
  }
  return out;
}

/** Removal keys for name/string/event-keyed lists; accepts strings or objects carrying `prop`. */
function namedRemovalKeys(raw, prop) {
  return (Array.isArray(raw) ? raw : [])
    .map((r) => (typeof r === 'string' ? r : (r && typeof r[prop] === 'string' ? r[prop] : null)))
    .filter((k) => typeof k === 'string' && k);
}

function unionByIdentity(list, items) {
  const out = Array.isArray(list) ? [...list] : [];
  const idOf = (x) => (typeof x === 'string' ? x : JSON.stringify(x));
  const seen = new Set(out.map(idOf));
  let added = 0;
  for (const item of Array.isArray(items) ? items : []) {
    const id = idOf(item);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(item);
    added++;
  }
  return { out, added };
}

// The two diff dialects that reach the store:
//   kind-keyed  — { api_contract: {endpoints}, ui_contract: {components}, ... }
//     (investigator auto-fix path; also the store's native shape)
//   scope-keyed — { backend: {add_endpoints, rules}, frontend: {add_components},
//                   database: {add_tables/change_tables} }
//     (contract-agent ITERATE mode, per contract-agent.md § 11 — the MAIN
//      concierge iterate path. Before this normalizer NOTHING consumed it:
//      diffs were decorative, the envelope never learned iterate changes,
//      and every stale-contract incident traced back here.)
const SCOPE_KEYS = new Set(['database', 'vectordb', 'backend', 'frontend', 'integration']);
const VERB_MAP = [
  { verbs: ['add_endpoints', 'change_endpoints', 'endpoints'], kind: 'api_contract', field: 'endpoints' },
  { verbs: ['add_components', 'change_components', 'components'], kind: 'ui_contract', field: 'components' },
  { verbs: ['add_views', 'secondary_views'], kind: 'ui_contract', field: 'secondary_views' },
  { verbs: ['add_tables', 'change_tables', 'tables'], kind: 'data_model', field: 'tables' },
  { verbs: ['rules', 'add_rules'], kind: 'business_logic_contract', field: 'rules' },
  { verbs: ['side_effects', 'add_side_effects'], kind: 'business_logic_contract', field: 'side_effects' },
  { verbs: ['triggers', 'add_triggers'], kind: 'business_logic_contract', field: 'triggers' },
  { verbs: ['remove_endpoints'], kind: 'api_contract', field: 'remove_endpoints' },
  { verbs: ['remove_components'], kind: 'ui_contract', field: 'remove_components' },
  { verbs: ['remove_views'], kind: 'ui_contract', field: 'remove_views' },
  { verbs: ['remove_tables'], kind: 'data_model', field: 'remove_tables' },
  { verbs: ['remove_columns'], kind: 'data_model', field: 'remove_columns' },
  { verbs: ['remove_rules'], kind: 'business_logic_contract', field: 'remove_rules' },
  { verbs: ['remove_side_effects'], kind: 'business_logic_contract', field: 'remove_side_effects' },
  { verbs: ['remove_triggers'], kind: 'business_logic_contract', field: 'remove_triggers' },
];

/**
 * Normalize any diff dialect to the kind-keyed shape mergeContractDiffs
 * understands. Kind-keyed input passes through; scope-keyed verb payloads
 * are folded into their kinds (arrays concatenated across scopes). Pure.
 */
export function normalizeContractDiffs(diffs) {
  if (!diffs || typeof diffs !== 'object') return diffs;
  const out = {};
  for (const [key, value] of Object.entries(diffs)) {
    if (!SCOPE_KEYS.has(key)) { out[key] = value; continue; }
    if (!value || typeof value !== 'object') continue;
    for (const [verb, payload] of Object.entries(value)) {
      // A scope value may itself carry kind-keyed sub-diffs (defensive).
      if (['api_contract', 'ui_contract', 'data_model', 'business_logic_contract', 'vector_engine'].includes(verb)) {
        out[verb] = mergeKindFragment(out[verb], payload);
        continue;
      }
      const mapping = VERB_MAP.find((m) => m.verbs.includes(verb));
      if (!mapping) {
        // A silently-dropped verb is how removal drift stayed hidden — an
        // unmapped verb must be loud even though it changes nothing.
        if (payload != null && (!Array.isArray(payload) || payload.length)) {
          tlog('[contract-store] unknown iterate diff verb "%s" under scope "%s" — dropped, no envelope change', verb, key);
        }
        continue;
      }
      if (!Array.isArray(payload) || payload.length === 0) continue;
      const kind = out[mapping.kind] || (out[mapping.kind] = {});
      kind[mapping.field] = [...(kind[mapping.field] || []), ...payload];
    }
  }
  return out;
}

const REMOVAL_FIELDS = ['remove_endpoints', 'remove_components', 'remove_views', 'remove_rules', 'remove_side_effects', 'remove_triggers'];

/**
 * True when a (normalized or raw) diff object carries any remove_* payload.
 * Spawn-message builders use this to switch the rendered prose from
 * "additions/changes" to an explicit deletion instruction.
 */
export function diffHasRemovals(diffs) {
  const normalized = normalizeContractDiffs(diffs);
  if (!normalized || typeof normalized !== 'object') return false;
  return Object.values(normalized).some((kind) =>
    kind && typeof kind === 'object'
    && REMOVAL_FIELDS.some((f) => Array.isArray(kind[f]) && kind[f].length));
}

function mergeKindFragment(existing, fragment) {
  if (!existing) return fragment;
  if (!fragment || typeof fragment !== 'object') return existing;
  const out = { ...existing };
  for (const [k, v] of Object.entries(fragment)) {
    out[k] = Array.isArray(v) && Array.isArray(out[k]) ? [...out[k], ...v] : v;
  }
  return out;
}

/**
 * Pure merge of iterate contract diffs into a prior contract. Never mutates
 * its inputs. Accepts both diff dialects (see normalizeContractDiffs) and
 * tolerates snake_case and camelCase kind keys.
 *
 * @param {{dataModel?, apiContract?, vectorEngine?, uiContract?, businessLogicContract?}} contract
 * @param {object|null} rawDiffs — iterate.contractDiffs
 * @returns {{merged: object, changes: string[]}} changes is a human-readable
 *   list of merged kinds (empty when the diff contained nothing applicable).
 */
export function mergeContractDiffs(contract, rawDiffs) {
  const diffs = normalizeContractDiffs(rawDiffs);
  const merged = {
    dataModel: contract?.dataModel ?? null,
    apiContract: contract?.apiContract ?? null,
    vectorEngine: contract?.vectorEngine ?? null,
    uiContract: contract?.uiContract ?? null,
    businessLogicContract: contract?.businessLogicContract ?? null,
  };
  const changes = [];
  if (!diffs || typeof diffs !== 'object') return { merged, changes };
  const pick = (snake, camel) => diffs[snake] ?? diffs[camel] ?? null;

  const apiDiff = pick('api_contract', 'apiContract');
  if (apiDiff && typeof apiDiff === 'object') {
    const valid = (Array.isArray(apiDiff.endpoints) ? apiDiff.endpoints : [])
      .filter((ep) => ep && typeof ep.method === 'string' && typeof ep.path === 'string');
    let endpoints = merged.apiContract?.endpoints;
    const parts = [];
    if (valid.length) {
      // Endpoint replace is whole-object: a diff entry with a PARTIAL request
      // spec silently REMOVES the omitted fields from the envelope, and every
      // downstream consumer stops sending them while the app still requires
      // them (observed: a remove-equipment diff dropped `severity`). The
      // replace stands — omission IS the removal mechanism — but dropped
      // fields must be loud, not silent.
      const prior = endpoints || [];
      for (const ep of valid) {
        const old = prior.find((p) => p && `${p.method} ${p.path}` === `${ep.method} ${ep.path}`);
        if (!old || !old.request || !ep.request || typeof old.request !== 'object' || typeof ep.request !== 'object') continue;
        const dropped = Object.keys(old.request).filter((f) => !(f in ep.request));
        if (dropped.length) {
          tlog('[contract-store] %s %s replace DROPS request field(s): %s — intended removal or an under-specified diff?',
            ep.method, ep.path, dropped.join(', '));
        }
      }
      const { out, added, replaced } = upsertBy(endpoints, valid, (ep) => `${ep.method} ${ep.path}`);
      endpoints = out;
      parts.push(`+${added}/~${replaced}`);
    }
    const removalKeys = endpointRemovalKeys(apiDiff.remove_endpoints);
    if (removalKeys.length) {
      const epKey = (ep) => `${String(ep.method).toUpperCase()} ${ep.path}`;
      const { out, removed } = removeBy(endpoints, removalKeys, epKey, {
        skipKeys: new Set(valid.map(epKey)), label: 'remove_endpoints',
      });
      endpoints = out;
      if (removed) parts.push(`-${removed}`);
    }
    if (parts.length) {
      merged.apiContract = { ...(merged.apiContract || {}), endpoints };
      changes.push(`api_contract(${parts.join('/')} endpoints)`);
    }
  }

  const uiDiff = pick('ui_contract', 'uiContract');
  if (uiDiff && typeof uiDiff === 'object') {
    const ui = { ...(merged.uiContract || {}) };
    const parts = [];
    if (Array.isArray(uiDiff.components) && uiDiff.components.length) {
      const { out, added, replaced } = upsertBy(
        ui.components, uiDiff.components.filter((c) => c && c.name), (c) => c.name, { mergeItem: true });
      ui.components = out;
      parts.push(`+${added}/~${replaced} components`);
    }
    if (Array.isArray(uiDiff.secondary_views) && uiDiff.secondary_views.length) {
      const { out, added } = unionByIdentity(ui.secondary_views, uiDiff.secondary_views.filter((v) => typeof v === 'string'));
      ui.secondary_views = out;
      if (added) parts.push(`+${added} views`);
    }
    const removeComponents = namedRemovalKeys(uiDiff.remove_components, 'name');
    if (removeComponents.length) {
      const upserted = new Set((Array.isArray(uiDiff.components) ? uiDiff.components : []).map((c) => c?.name));
      const { out, removed } = removeBy(ui.components, removeComponents, (c) => c?.name, {
        skipKeys: upserted, label: 'remove_components',
      });
      ui.components = out;
      if (removed) parts.push(`-${removed} components`);
    }
    const removeViews = namedRemovalKeys(uiDiff.remove_views);
    if (removeViews.length) {
      const added = new Set((Array.isArray(uiDiff.secondary_views) ? uiDiff.secondary_views : []).filter((v) => typeof v === 'string'));
      const { out, removed } = removeBy(ui.secondary_views, removeViews, (v) => v, {
        skipKeys: added, label: 'remove_views',
      });
      ui.secondary_views = out;
      if (removed) parts.push(`-${removed} views`);
    }
    for (const key of ['primary_view', 'primary_action']) {
      if (typeof uiDiff[key] === 'string' && uiDiff[key]) { ui[key] = uiDiff[key]; parts.push(key); }
    }
    if (parts.length) {
      merged.uiContract = ui;
      changes.push(`ui_contract(${parts.join(', ')})`);
    }
  }

  const dmDiff = pick('data_model', 'dataModel');
  for (const key of ['remove_tables', 'remove_columns']) {
    if (dmDiff && Array.isArray(dmDiff[key]) && dmDiff[key].length) {
      // Tables/columns are never retired by a diff: the data persists, the
      // live schema-drift check would go blind, and a fresh volume would lose
      // the DDL. Out-of-scope the table in the iterate summary instead.
      tlog('[contract-store] %s is not supported — table/column contract entries are never removed by a diff; entries kept', key);
    }
  }
  if (dmDiff && Array.isArray(dmDiff.tables) && dmDiff.tables.length) {
    const tables = Array.isArray(merged.dataModel?.tables) ? merged.dataModel.tables.map((t) => ({ ...t })) : [];
    let added = 0, mergedCount = 0;
    for (const t of dmDiff.tables) {
      if (!t || !t.name) continue;
      const idx = tables.findIndex((x) => x && x.name === t.name);
      if (idx === -1) { tables.push(t); added++; continue; }
      const { out } = upsertBy(tables[idx].columns, (t.columns || []).filter((c) => c && c.name), (c) => c.name, { mergeItem: true });
      tables[idx] = { ...tables[idx], ...t, columns: out };
      mergedCount++;
    }
    merged.dataModel = { ...(merged.dataModel || {}), tables };
    changes.push(`data_model(+${added}/~${mergedCount} tables)`);
  }

  const blDiff = pick('business_logic_contract', 'businessLogicContract');
  if (blDiff && typeof blDiff === 'object') {
    const bl = { ...(merged.businessLogicContract || {}) };
    const parts = [];
    if (Array.isArray(blDiff.triggers) && blDiff.triggers.length) {
      const { out, added, replaced } = upsertBy(
        bl.triggers, blDiff.triggers.filter((t) => t && t.event), (t) => t.event, { mergeItem: true });
      bl.triggers = out;
      parts.push(`+${added}/~${replaced} triggers`);
    }
    for (const key of ['rules', 'side_effects']) {
      if (Array.isArray(blDiff[key]) && blDiff[key].length) {
        const { out, added } = unionByIdentity(bl[key], blDiff[key]);
        bl[key] = out;
        if (added) parts.push(`+${added} ${key}`);
      }
    }
    const removeTriggers = namedRemovalKeys(blDiff.remove_triggers, 'event');
    if (removeTriggers.length) {
      const upserted = new Set((Array.isArray(blDiff.triggers) ? blDiff.triggers : []).map((t) => t?.event));
      const { out, removed } = removeBy(bl.triggers, removeTriggers, (t) => t?.event, {
        skipKeys: upserted, label: 'remove_triggers',
      });
      bl.triggers = out;
      if (removed) parts.push(`-${removed} triggers`);
    }
    const idOf = (x) => (typeof x === 'string' ? x : JSON.stringify(x));
    for (const [verb, key] of [['remove_rules', 'rules'], ['remove_side_effects', 'side_effects']]) {
      if (!Array.isArray(blDiff[verb]) || !blDiff[verb].length) continue;
      const addedIds = new Set((Array.isArray(blDiff[key]) ? blDiff[key] : []).map(idOf));
      const { out, removed } = removeBy(bl[key], blDiff[verb].map(idOf), idOf, {
        skipKeys: addedIds, label: verb,
      });
      bl[key] = out;
      if (removed) parts.push(`-${removed} ${key}`);
    }
    for (const key of ['llmIntegration', 'llmApiSpec', 'contentSchema']) {
      if (blDiff[key] != null) { bl[key] = blDiff[key]; parts.push(key); }
    }
    if (parts.length) {
      merged.businessLogicContract = bl;
      changes.push(`business_logic_contract(${parts.join(', ')})`);
    }
  }

  const veDiff = pick('vector_engine', 'vectorEngine');
  if (veDiff != null && veDiff !== '') {
    merged.vectorEngine = veDiff;
    changes.push('vector_engine');
  }

  return { merged, changes };
}

/**
 * Build the next revisions array for a persist. Fresh finalization resets
 * the log; an iterate preserves history and appends its own entry.
 */
export function nextRevisions(priorRevisions, revision) {
  const prior = Array.isArray(priorRevisions) ? priorRevisions : [];
  if (!revision) return prior;
  return [...prior, revision].slice(-MAX_REVISIONS);
}

/**
 * Contract adoption — feed the reconciler-judge's 'legitimate' verdicts back
 * into the envelope. The judge already proves these routes exist in code and
 * fit the app's intent; without adoption that knowledge was discarded, so a
 * contract that missed a feature (pre-store apps, lost diffs) stayed blind
 * forever and the endpoint probe never covered the extra surface.
 *
 * Only `backend-extra-route` extras are adoptable — they are code-present /
 * contract-absent with a concrete (method, path). `coverage-gap-*` kinds are
 * the opposite direction (contract-present, code-missing) and must never be
 * written back. Existing envelope endpoints are never touched: adoption adds
 * skeletal `{ method, path, adopted: true }` entries for genuinely new
 * routes only, so a richer contract entry can't be clobbered.
 *
 * Never throws. @returns {{adopted: number, changes: string[]}}
 */
export function adoptLegitimateExtras(workspaceDir, judgedExtras) {
  try {
    const candidates = (Array.isArray(judgedExtras) ? judgedExtras : []).filter((e) =>
      e && e.judgment === 'legitimate' && e.kind === 'backend-extra-route'
      && typeof e.method === 'string' && typeof e.path === 'string');
    if (!candidates.length) return { adopted: 0, changes: [] };

    const envelope = readContracts(workspaceDir);
    if (!envelope || !envelope.data) return { adopted: 0, changes: [] };
    const existing = new Set((envelope.data.apiContract?.endpoints || envelope.data.api_contract?.endpoints || [])
      .filter((ep) => ep && ep.method && ep.path)
      .map((ep) => `${ep.method.toUpperCase()} ${ep.path}`));

    const seen = new Set();
    const fresh = [];
    for (const e of candidates) {
      // Contract convention stores paths WITHOUT the /api prefix (Traefik
      // strips it). Normalize so an adopted route matches how the probe and
      // type generators read the contract. Skip dynamic/wildcard paths — a
      // template-literal or glob path is scanner noise, not a route.
      const normPath = e.path.replace(/^\/api(?=\/)/, '');
      if (/[*$]|\$\{/.test(normPath)) continue;
      const key = `${e.method.toUpperCase()} ${normPath}`;
      if (existing.has(key) || seen.has(key)) continue;
      seen.add(key);
      fresh.push({ method: e.method.toUpperCase(), path: normPath, adopted: true });
    }
    if (!fresh.length) return { adopted: 0, changes: [] };

    const { changes } = mergeAndPersistIterateDiffs(workspaceDir, {
      api_contract: { endpoints: fresh },
    }, { summary: `adoption: ${fresh.length} legitimate route(s) from reconciler judge` });
    tlog('[contract-store] adopted %d legitimate route(s) into the envelope: %s',
      fresh.length, fresh.map((f) => `${f.method} ${f.path}`).join(', '));
    return { adopted: fresh.length, changes };
  } catch (err) {
    tlog('[contract-store] adoption failed (non-blocking): %s', err?.message || err);
    return { adopted: 0, changes: [] };
  }
}

/**
 * Merge iterate diffs straight into the on-disk envelope and persist. Used
 * by dispatch paths that do NOT go through setOrchestrationContext (the
 * single-scope direct iterate), which previously left the envelope stale.
 *
 * Preserves all other envelope keys (fileStructure, tasksByScope, ...).
 * Never throws — a store failure must not block a dispatch.
 *
 * @returns {{merged: object|null, changes: string[]}}
 */
export function mergeAndPersistIterateDiffs(workspaceDir, diffs, { summary } = {}) {
  try {
    const envelope = readContracts(workspaceDir);
    if (!envelope || !envelope.data) return { merged: null, changes: [] };
    const data = envelope.data;
    const { merged, changes } = mergeContractDiffs(data, diffs);
    if (!changes.length) return { merged: data, changes };
    writeContracts(workspaceDir, {
      ...data,
      ...merged,
      revisions: nextRevisions(data.revisions, { ts: Date.now(), summary: summary || 'iterate', kinds: changes }),
    });
    invalidateContractsCache(workspaceDir);
    tlog('[contract-store] merged iterate diffs into envelope: %s', changes.join(', '));
    return { merged: { ...data, ...merged }, changes };
  } catch (err) {
    tlog('[contract-store] merge-and-persist failed (non-blocking): %s', err?.message || err);
    return { merged: null, changes: [] };
  }
}
