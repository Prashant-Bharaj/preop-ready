/**
 * Playbook Session 1 / Case 5 — planner stress: a hopelessly vague prompt.
 * The pass criterion is that the harness ASKS instead of guessing, then
 * builds a coherent small app from the answers. Behavior test is generic
 * (any created row must be retrievable).
 */

import { api, apiSmart, discoverEp } from '../lib/app-client.mjs';

export default {
  name: 'vague-prompt',
  prompt: 'Build me something to help my lab work better.',

  // Runner asserts clarifyRounds >= 1 for this scenario (expectations below);
  // the answer pins the scope down tight so the build stays small.
  answerClarify() {
    return [
      'A simple daily task checklist for lab technicians.',
      'Single role, everyone sees the same list.',
      'A task has a title and a done/not-done state. Add, complete, delete.',
      'No AI, no reports, no extras.',
    ].join(' ');
  },

  expectations: { aiApp: false, mustClarify: true },

  async threeAction(marker) {
    const actions = [];

    const createEp = discoverEp('POST', /task|item|todo|checklist/i) || discoverEp('POST', /./);
    const create = createEp
      ? await apiSmart('POST', createEp.path, { role: 'technician', spec: createEp.request, marker, overrides: { title: `Bench task ${marker}` } })
      : { status: -1, text: 'no create endpoint in contract' };
    const id = create.json?.id ?? null;
    actions.push({
      name: 'create item',
      ok: create.status >= 200 && create.status < 300,
      detail: `HTTP ${create.status}${id != null ? ` id=${id}` : ''}`,
    });

    const listEp = discoverEp('GET', /task|item|todo|checklist/i) || discoverEp('GET', /./);
    const list = listEp ? await api('GET', listEp.path, { role: 'technician' }) : { status: -1, text: 'no list endpoint' };
    const found = JSON.stringify(list.json || list.text || '').includes(marker);
    actions.push({
      name: 'list contains it',
      ok: list.status === 200 && found,
      detail: `HTTP ${list.status} found=${found}`,
    });

    return actions;
  },
};