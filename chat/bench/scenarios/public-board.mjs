/**
 * No-auth class — every other scenario has roles; this one asserts the
 * OPPOSITE: a fully public app must not gate anything and must not scope
 * data per-user. (In production the ALB still injects identity headers —
 * "public" means the app ignores them, so the bench posts as one persona
 * and reads as another.)
 */

import { api, apiSmart, discoverEp } from '../lib/app-client.mjs';

export default {
  name: 'public-board',
  prompt: 'Build a public idea board for the plant. Anyone can post an improvement idea and browse all ideas. No login, no roles, completely open.',

  answerClarify() {
    return [
      'Completely public — no roles, no login, no moderation.',
      'Ideas have a title and a description, newest first.',
      'No voting, no comments, no categories. Keep it minimal.',
    ].join(' ');
  },

  expectations: { aiApp: false },

  async threeAction(marker) {
    const actions = [];

    const ideaEp = discoverEp('POST', /idea|post|suggestion/i);
    const idea = ideaEp
      ? await apiSmart('POST', ideaEp.path, {
          role: 'operator', spec: ideaEp.request, marker,
          overrides: { title: `Bench idea ${marker}` },
        })
      : { status: -1, json: null, text: 'no idea endpoint in contract' };
    actions.push({
      name: 'anyone can post an idea (no role gating)',
      ok: idea.status >= 200 && idea.status < 300,
      detail: `HTTP ${idea.status} ${(idea.text || '').slice(0, 80)}`,
    });

    // A DIFFERENT persona must see it — public means no per-user scoping.
    const listEp = discoverEp('GET', /idea|post|suggestion/i);
    const list = listEp
      ? await api('GET', listEp.path, { role: 'technician' })
      : { status: -1, text: 'no list endpoint in contract' };
    const listBody = JSON.stringify(list.json || list.text || '');
    actions.push({
      name: 'another visitor sees the idea (no per-user scoping)',
      ok: list.status === 200 && listBody.includes(marker),
      detail: `HTTP ${list.status} visibleAcrossUsers=${listBody.includes(marker)}`,
    });

    // And the reverse direction, for symmetry.
    const idea2 = ideaEp
      ? await apiSmart('POST', ideaEp.path, {
          role: 'technician', spec: ideaEp.request, marker,
          overrides: { title: `Bench idea two ${marker}` },
        })
      : { status: -1, text: 'n/a' };
    const list2 = listEp ? await api('GET', listEp.path, { role: 'operator' }) : { status: -1, text: 'n/a' };
    const both = JSON.stringify(list2.json || list2.text || '');
    actions.push({
      name: 'both ideas visible to everyone',
      ok: idea2.status < 300 && list2.status === 200 && both.includes(`Bench idea ${marker}`) && both.includes(`Bench idea two ${marker}`),
      detail: `HTTP ${idea2.status}/${list2.status} bothVisible=${both.includes(`Bench idea two ${marker}`)}`,
    });

    return actions;
  },
};
