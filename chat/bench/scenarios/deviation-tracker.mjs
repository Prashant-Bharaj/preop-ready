/**
 * Playbook Session 1 / Case 4 — multi-role workflow + audit + CSV export.
 * 3-action test: report as operator → close as qa_lead → export CSV contains
 * the marker. Plus a role-gate probe (operator hitting an admin surface).
 */

import { api, apiSmart, contractEndpoints, discoverEp, fill } from '../lib/app-client.mjs';

export default {
  name: 'deviation-tracker',
  prompt: 'Build a deviation tracker for our production line. Operators report deviations with severity and photos, QA leads review, comment, and close them, admins manage plant areas. Every action must be logged for audit, and QA can export the audit trail as CSV.',

  answerClarify() {
    return [
      'Deviations capture: plant area, equipment, root cause category, severity, description.',
      'Status stages: Open, Under Review, Closed.',
      'QA leads see all deviations across the plant (no area assignments needed).',
      'Include search and filtering. No email alerts, no dashboard — keep this build focused.',
    ].join(' ');
  },

  expectations: { aiApp: false },

  // Session 2 iterate ladder (runner executes with BENCH_LADDER=1):
  // feature-add, cosmetic, explicit removal — each followed by a full
  // regression re-run of the 3-action test by the runner.
  iterates: [
    { name: 'add-feature', message: 'Add a free-text corrective action field to deviations that QA leads fill in when closing them.' },
    { name: 'cosmetic', message: "Make the app header title say 'Bench Deviation Tracker'." },
    {
      name: 'explicit-removal',
      message: 'Remove the equipment field from deviation reports — we do not need it.',
      // Removal hygiene: contract ⊆ reality. Whatever the iterate did (drop
      // just the field, or delete whole routes and declare remove_endpoints),
      // the envelope must not keep listing routes the app 404s for every
      // role. Deliberately NOT asserting a specific deletion — keeping the
      // routes and dropping only the field is a legitimate shape.
      async verify() {
        const eps = contractEndpoints().filter((e) => e && e.method && e.path
          && !/whoami|health/i.test(e.path) && !e.path.includes(':'));
        const dead = [];
        for (const ep of eps) {
          let all404 = true;
          for (const role of ['qa_lead', 'admin', 'operator']) {
            const r = await api(ep.method, ep.path, { role });
            if (r.status !== 404) { all404 = false; break; }
          }
          if (all404) dead.push(`${ep.method} ${ep.path}`);
        }
        return [{
          name: 'contract lists only served endpoints (removal hygiene)',
          ok: dead.length === 0,
          detail: dead.length
            ? `contract still lists dead route(s): ${dead.join(', ')}`
            : `${eps.length} contracted route(s) all served`,
        }];
      },
    },
  ],

  async threeAction(marker) {
    const actions = [];

    // Precondition: a plant area to report against (admin creates it).
    const areaEp = discoverEp('POST', /area/i);
    const area = areaEp
      ? await apiSmart('POST', areaEp.path, { role: 'admin', spec: areaEp.request, marker, overrides: { name: `Bench Line ${marker}` } })
      : { status: -1, json: null, text: 'no plant-area endpoint' };
    const areaId = area.json?.id ?? area.json?.plant_area?.id ?? 1;

    const devEp = discoverEp('POST', /deviation/i);
    const report = devEp
      ? await apiSmart('POST', devEp.path, { role: 'operator', spec: devEp.request, marker, overrides: { plant_area_id: areaId, description: `Bench deviation ${marker}` } })
      : { status: -1, text: 'no POST /deviations-like endpoint in contract' };
    const devId = report.json?.id ?? report.json?.deviation?.id ?? null;
    actions.push({
      name: 'operator reports deviation',
      ok: report.status >= 200 && report.status < 300 && devId != null,
      detail: `HTTP ${report.status}${devId != null ? ` id=${devId}` : ` ${(report.text || '').slice(0, 120)}`}`,
    });

    const statusEp = discoverEp('PUT', /status/i) || discoverEp('PATCH', /status/i) || discoverEp('PATCH', /deviation/i) || discoverEp('PUT', /deviation/i);
    let closed = { status: -1, text: 'no status-transition endpoint in contract' };
    if (statusEp && devId == null) closed.text = 'skipped: deviation was never created';
    if (statusEp && devId != null) {
      // Walk the declared stages using the CONTRACT's enum values (e.g.
      // "(Open|Under Review|Closed)") — first value is the initial state,
      // last is terminal. The fallback list includes the initial state too so
      // slice(1) never skips a transition (apps enforce no-skipping rules).
      const enumMatch = /\(([^)]+\|[^)]+)\)/.exec(JSON.stringify(statusEp.request || {}));
      const stages = enumMatch ? enumMatch[1].split('|').map((s) => s.trim()) : ['Open', 'Under Review', 'Closed'];
      for (const stage of stages.slice(1)) {
        closed = await apiSmart(statusEp.method, fill(statusEp.path, { id: devId }), {
          role: 'qa_lead', spec: statusEp.request, marker,
          overrides: { status: stage, ...('corrective_action' in (statusEp.request || {}) ? { corrective_action: `Bench corrective ${marker}` } : {}) },
        });
      }
    }
    actions.push({
      name: 'qa_lead closes it',
      ok: closed.status >= 200 && closed.status < 300,
      detail: `HTTP ${closed.status} ${(closed.text || '').slice(0, 100)}`,
    });

    const exportEp = discoverEp('GET', /export/i);
    // Contracts often leave export rights unstated and apps legitimately
    // pick qa_lead-or-admin — the assert is "an authorized elevated user can
    // export", not a role name. Fall back to admin on a role rejection.
    // Apps legitimately scope the export per deviation
    // (GET /deviations/:id/audit-logs/export) — fill OUR id, never send ':id'.
    const exportPath = exportEp ? fill(exportEp.path, { id: devId ?? 1 }) : null;
    const scopedExport = Boolean(exportEp && /:[A-Za-z_]+/.test(exportEp.path));
    let csv = exportEp
      ? await api('GET', exportPath, { role: 'qa_lead' })
      : { status: -1, text: 'no export endpoint in contract' };
    if (exportEp && (csv.status === 401 || csv.status === 403)) {
      csv = await api('GET', exportPath, { role: 'admin' });
    }
    // Marker text only lands in the CSV when the app copies field values into
    // audit details — contracts vary. Structural fallback: the audit trail
    // must reference OUR deviation (its id on a deviation-ish row) — or, for
    // an export already scoped to our deviation, simply carry rows.
    const csvRows = (csv.text || '').split('\n').filter((r) => r.trim());
    const hasMarker = (csv.text || '').includes(marker);
    const hasDevRow = devId != null && csvRows
      .some((row) => /deviation/i.test(row) && new RegExp(`(^|,)"?${devId}"?(,|$)`).test(row));
    const hasScopedRows = scopedExport && csvRows.length >= 2;
    actions.push({
      name: 'CSV export contains the audit trail',
      ok: csv.status === 200 && (hasMarker || hasDevRow || hasScopedRows),
      detail: `HTTP ${csv.status} markerInCsv=${hasMarker} devRowInCsv=${hasDevRow} scopedRows=${hasScopedRows ? csvRows.length - 1 : 'n/a'} bytes=${(csv.text || '').length}`,
    });

    // Role gate: operator must NOT be able to manage plant areas. Send a
    // COMPLETE payload (from the contract spec) so the only reason to reject
    // is the role — an incomplete body would 400 on validation and hide
    // whether the gate exists (the masking class fixed in sop-assistant). A
    // 2xx here means the operator created an admin-only resource: a real hole.
    const gate = areaEp
      ? await apiSmart('POST', areaEp.path, { role: 'operator', spec: areaEp.request, marker, overrides: { name: `Bench Forbidden ${marker}` } })
      : { status: -1, text: 'n/a' };
    const operatorCreated = gate.status >= 200 && gate.status < 300;
    actions.push({
      name: 'role gate: operator blocked from admin surface',
      ok: gate.status === 401 || gate.status === 403,
      detail: operatorCreated
        ? `HTTP ${gate.status} — AUTHZ DEFECT: operator created an admin-only resource (plant area)`
        : `HTTP ${gate.status} (expected 401/403)`,
    });

    return actions;
  },
};