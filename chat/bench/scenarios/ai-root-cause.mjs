/**
 * Playbook Session 1 / Case 2 — pure AI-chat, no RAG.
 * 3-action test: submit a description for analysis → response is REAL AI
 * (latency + content checks, the canned-template lesson) → history keeps it.
 */

import { api, apiSmart, discoverEp, discoverAllEp, fill } from '../lib/app-client.mjs';

export default {
  name: 'ai-root-cause',
  prompt: 'I want a tool where a technician pastes a deviation description and the AI suggests probable root causes and a proposed corrective action. Keep a history of past analyses per user.',

  answerClarify() {
    return [
      'Single role: technician.',
      'Input is free text only — no file uploads, no document search.',
      'The AI should return probable root causes and one recommended corrective action.',
      'History shows my own past analyses with timestamps. No extras.',
    ].join(' ');
  },

  expectations: { aiApp: true },

  async threeAction(marker) {
    const actions = [];

    const analyzeEp = discoverEp('POST', /analy|suggest|root|assess/i) || discoverEp('POST', /./);
    const description = `Mixer bearing seized during batch run, loud grinding noise before stop. Bench case ${marker}.`;
    const analyze = analyzeEp
      ? await apiSmart('POST', analyzeEp.path, { role: 'technician', spec: analyzeEp.request, marker, overrides: { description, text: description, deviation_description: description }, timeoutMs: 120_000 })
      : { status: -1, ms: 0, text: 'no analysis endpoint in contract' };
    actions.push({
      name: 'AI analysis returns',
      ok: analyze.status >= 200 && analyze.status < 300,
      detail: `HTTP ${analyze.status} in ${analyze.ms}ms ${(analyze.text || '').slice(0, 80)}`,
    });

    // The canned-template detector: a real MGA round trip takes seconds and
    // produces content the input didn't contain; ai_powered (if present)
    // must be true.
    const bodyText = JSON.stringify(analyze.json || analyze.text || '');
    const looksReal =
      analyze.ms > 2000 &&
      bodyText.length > 200 &&
      !/"ai_powered" *: *false/.test(bodyText);
    actions.push({
      name: 'response is real AI (latency + content, not a template)',
      ok: analyze.status < 300 && looksReal,
      detail: `latency=${analyze.ms}ms len=${bodyText.length} ai_powered_false=${/"ai_powered" *: *false/.test(bodyText)}`,
    });

    // Some contracts split analyze (stateless AI) from save (persistence) —
    // the UI calls both; so does the bench. Only when the analyze response
    // carried no id AND a distinct persistence POST exists.
    let savedId = analyze.json?.id ?? null;
    const saveEp = discoverAllEp('POST', /hist|analys|saved/i).find((ep) => ep.path !== analyzeEp?.path) ?? null;
    if (savedId == null && saveEp) {
      const save = await apiSmart('POST', saveEp.path, {
        role: 'technician', spec: saveEp.request, marker,
        overrides: {
          description, deviation_description: description, deviation_text: description,
          ...(analyze.json && typeof analyze.json === 'object' ? { root_causes: analyze.json.root_causes, corrective_action: analyze.json.corrective_action } : {}),
        },
      });
      savedId = save.json?.id ?? null;
    }

    const historyEp = discoverEp('GET', /hist|analys|analyses/i);
    const history = historyEp
      ? await api('GET', fill(historyEp.path, {}), { role: 'technician' })
      : { status: -1, text: 'no history endpoint in contract' };
    const historyBody = JSON.stringify(history.json || history.text || '');
    const found = historyBody.includes(marker);
    // Structural fallback: the saved row's id in the list proves persistence
    // even when the list omits the input-text field carrying the marker.
    const foundId = savedId != null && new RegExp(`"id"\\s*:\\s*"?${savedId}"?`).test(historyBody);
    actions.push({
      name: 'history keeps the analysis',
      ok: history.status === 200 && (found || foundId),
      detail: `HTTP ${history.status} found=${found} foundId=${foundId}`,
    });

    return actions;
  },
};
