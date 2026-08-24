/**
 * Playbook Session 1 / Case 1 — plain CRUD control (no AI anywhere).
 * 3-action test: create equipment → log a maintenance event → search finds it.
 */

import { api, apiSmart, discoverEp, fill } from '../lib/app-client.mjs';

export default {
  name: 'crud-logbook',
  prompt: 'Build a lab equipment logbook: technicians register equipment with name, serial number, location and status, log maintenance events against each item, and search the list. Managers can delete equipment.',

  answerClarify() {
    return [
      'Two roles: technician and manager.',
      'Equipment fields: name, serial number, location, status (in service / under maintenance / retired).',
      'Maintenance events: date, description, technician who did it.',
      'Search by name and serial number is enough. No extras beyond that — keep it simple.',
    ].join(' ');
  },

  // Non-AI control case: the plan must NOT contain a vectordb scope and the
  // report must not mention MGA.
  expectations: { aiApp: false },

  async threeAction(marker) {
    const actions = [];

    const createEp = discoverEp('POST', /equip/i);
    const create = createEp
      ? await apiSmart('POST', createEp.path, { role: 'technician', spec: createEp.request, marker, overrides: { name: `Bench Mixer ${marker}`, serial_number: `SN-${marker}` } })
      : { status: -1, text: 'no POST /equipment-like endpoint in contract' };
    const createdId = create.json?.id ?? create.json?.equipment?.id ?? null;
    actions.push({
      name: 'create equipment',
      ok: create.status >= 200 && create.status < 300 && createdId != null,
      detail: `HTTP ${create.status}${createdId != null ? ` id=${createdId}` : ` body=${(create.text || '').slice(0, 120)}`}`,
    });

    const eventEp = discoverEp('POST', /maint|event|log/i);
    const logEvent = (eventEp && createdId != null)
      ? await apiSmart('POST', fill(eventEp.path, { id: createdId }), { role: 'technician', spec: eventEp.request, marker, overrides: { equipment_id: createdId, description: `Bench maintenance ${marker}` } })
      : { status: -1, text: eventEp ? 'no created id to log against' : 'no maintenance-event endpoint in contract' };
    actions.push({
      name: 'log maintenance event',
      ok: logEvent.status >= 200 && logEvent.status < 300,
      detail: `HTTP ${logEvent.status} ${(logEvent.text || '').slice(0, 100)}`,
    });

    const listEp = discoverEp('GET', /equip/i);
    const search = listEp
      ? await api('GET', `${listEp.path}?search=SN-${marker}&q=SN-${marker}`, { role: 'technician' })
      : { status: -1, text: 'no GET /equipment-like endpoint' };
    const found = JSON.stringify(search.json || search.text || '').includes(marker);
    actions.push({
      name: 'search finds it',
      ok: search.status === 200 && found,
      detail: `HTTP ${search.status} found=${found}`,
    });

    return actions;
  },
};