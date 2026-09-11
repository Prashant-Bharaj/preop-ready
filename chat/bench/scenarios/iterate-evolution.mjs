/**
 * Iterate-evolution stress — start minimal, grow through 5 iterates that
 * exercise every contract-evolution class we've been burned by: add-field,
 * add-entity, add-capability, RENAME (the whole-endpoint-replace rule), and
 * REMOVE (the partial-diff clobber class). The ladder always runs for this
 * scenario (ladder: 'always') — evolution IS the scenario.
 *
 * The base actions are deliberately re-discovered from the CONTRACT on every
 * regression pass so the bench follows renames the way a rebuilt frontend
 * would; what must never break is the BEHAVIOR: create a note, find it again.
 */

import { api, apiSmart, discoverEp } from '../lib/app-client.mjs';

export default {
  name: 'iterate-evolution',
  prompt: 'Build a simple team notes app. Notes have a title and content. Anyone on the team can add notes and see the full list.',

  answerClarify() {
    return [
      'No roles — everyone can add and view.',
      'Notes are title plus content, newest first.',
      'No search, no categories, no attachments — keep the first version minimal.',
    ].join(' ');
  },

  expectations: { aiApp: false },
  ladder: 'always',

  iterates: [
    { name: 'add-field', message: "Add a category to notes: general, urgent, or info. Show it in the list." },
    { name: 'add-entity', message: 'Add projects: a project has a name, and each note can optionally belong to a project.' },
    { name: 'add-search', message: 'Add text search over note titles and content.' },
    { name: 'rename-field', message: "Rename the note field 'content' to 'body' everywhere — API and UI." },
    { name: 'remove-field', message: 'Remove the category field from notes — we do not need it anymore.' },
  ],

  async threeAction(marker) {
    const actions = [];

    // Create a note. Field names come from the CURRENT contract revision —
    // after the rename iterate this must automatically send `body`.
    const noteEp = discoverEp('POST', /note/i);
    const note = noteEp
      ? await apiSmart('POST', noteEp.path, {
          role: 'operator', spec: noteEp.request, marker,
          overrides: { title: `Bench note ${marker}` },
        })
      : { status: -1, json: null, text: 'no note-creation endpoint in contract' };
    const noteId = note.json?.id ?? null;
    actions.push({
      name: 'create note',
      ok: note.status >= 200 && note.status < 300 && noteId != null,
      detail: `HTTP ${note.status}${noteId != null ? ` id=${noteId}` : ` ${(note.text || '').slice(0, 100)}`}`,
    });

    // The list must contain it (marker lands in title via the override, and
    // in the content/body field via payloadFromSpec's text-ish fill).
    const listEp = discoverEp('GET', /note/i);
    const list = listEp
      ? await api('GET', listEp.path, { role: 'operator' })
      : { status: -1, text: 'no list endpoint in contract' };
    const listBody = JSON.stringify(list.json || list.text || '');
    actions.push({
      name: 'list contains the note',
      ok: list.status === 200 && listBody.includes(marker),
      detail: `HTTP ${list.status} found=${listBody.includes(marker)}`,
    });

    // Search — only asserted once the contract has it (post add-search).
    const searchEp = discoverEp('GET', /search/i);
    const searchSpec = listEp && /search|q\b|query/i.test(JSON.stringify(listEp.request || {}));
    if (searchEp || searchSpec) {
      const path = searchEp ? searchEp.path : listEp.path;
      const sep = path.includes('?') ? '&' : '?';
      const search = await api('GET', `${path}${sep}q=${encodeURIComponent(marker)}&search=${encodeURIComponent(marker)}&query=${encodeURIComponent(marker)}`, { role: 'operator' });
      const found = JSON.stringify(search.json || search.text || '').includes(marker);
      actions.push({
        name: 'search finds the note',
        ok: search.status === 200 && found,
        detail: `HTTP ${search.status} found=${found}`,
      });
    }

    return actions;
  },
};
