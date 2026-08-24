/**
 * Aggregation class — computed/grouped queries, a different backend shape
 * than row-CRUD: the app must SUM durations per machine and honor date-range
 * filters. Asserts arithmetic against data the bench itself created.
 */

import { api, apiSmart, discoverEp, discoverAllEp } from '../lib/app-client.mjs';

export default {
  name: 'ops-dashboard',
  prompt: 'Build a downtime tracking dashboard for production machines. Technicians log downtime events with the machine, a cause category, and duration in minutes. The dashboard shows total downtime per machine and per cause, filterable by date range.',

  answerClarify() {
    return [
      'Single role: technician — logs events and views the dashboard.',
      'Cause categories are exactly: mechanical, electrical, operational.',
      'Duration is whole minutes. Events carry the date they happened.',
      'Dashboard needs totals per machine and per cause with a from/to date filter. No extras.',
    ].join(' ');
  },

  expectations: { aiApp: false },

  async threeAction(marker) {
    const actions = [];

    // A machine + two downtime events (25 + 35 min) against it. The machine
    // id is extracted from wrapped shapes too ({machine:{id}}); a failed
    // create is its own assert instead of a silent `?? 1` cascade (which
    // produced "Machine with id 1 not found" downstream — observed).
    const machineEp = discoverEp('POST', /machine/i);
    const machine = machineEp
      ? await apiSmart('POST', machineEp.path, { role: 'technician', spec: machineEp.request, marker, overrides: { name: `Bench Machine ${marker}` } })
      : { status: -1, json: null, text: 'no machine endpoint in contract' };
    const machineId = machine.json?.id
      ?? Object.values(machine.json || {}).find((v) => v && typeof v === 'object' && v.id != null)?.id
      ?? null;
    actions.push({
      name: 'machine is created',
      ok: machine.status >= 200 && machine.status < 300 && machineId != null,
      detail: `HTTP ${machine.status}${machineId != null ? ` id=${machineId}` : ` ${(machine.text || '').slice(0, 110)}`}`,
    });

    const eventEp = discoverAllEp('POST', /downtime|event|log/i).find((ep) => ep.path !== machineEp?.path) ?? null;
    let created = 0;
    let lastEv = null;
    for (const minutes of [25, 35]) {
      if (!eventEp) break;
      lastEv = await apiSmart('POST', eventEp.path, {
        role: 'technician', spec: eventEp.request, marker,
        // Naming variants are filtered to the contract spec by payloadFromSpec,
        // so strict-validating apps only ever see the declared field.
        overrides: { ...(machineId != null ? { machine_id: machineId } : {}), duration_minutes: minutes, duration: minutes, minutes, cause: 'mechanical', cause_category: 'mechanical', category: 'mechanical' },
      });
      if (lastEv.status >= 200 && lastEv.status < 300) created++;
    }
    actions.push({
      name: 'technician logs two downtime events',
      ok: created === 2,
      detail: eventEp
        ? `created ${created}/2 via ${eventEp.path}${created < 2 && lastEv ? ` — last: HTTP ${lastEv.status} ${(lastEv.text || '').slice(0, 110)}` : ''}`
        : 'no downtime-event endpoint in contract',
    });

    // Aggregates: our machine's total must be 60 minutes. Aggregate-ish
    // paths are preferred over raw event lists — a "downtime" match alone
    // once selected GET /downtime-events, whose rows contain the machine
    // but never a summed total (observed: app aggregated perfectly at
    // /aggregates/by-machine while the bench asserted against the list).
    const statsEp = discoverAllEp('GET', /aggregat|stat|summar|dashboard/i).find((ep) => !ep.path.includes(':'))
      ?? discoverAllEp('GET', /total|downtime/i).find((ep) => !ep.path.includes(':'))
      ?? null;
    const stats = statsEp
      ? await api('GET', statsEp.path, { role: 'technician' })
      : { status: -1, text: 'no stats endpoint in contract' };
    const statsBody = JSON.stringify(stats.json || stats.text || '');
    const hasOurMachine = statsBody.includes(String(machineId)) || statsBody.includes(marker);
    const hasTotal = /\b60\b|"60"/.test(statsBody);
    actions.push({
      name: 'dashboard aggregates our machine to 60 minutes',
      ok: stats.status === 200 && hasOurMachine && hasTotal,
      detail: `HTTP ${stats.status} machineInStats=${hasOurMachine} total60=${hasTotal}`,
    });

    // Date filter: a range far in the past must exclude our events.
    let filteredOk = false;
    let filterDetail = 'no stats endpoint';
    if (statsEp) {
      const sep = statsEp.path.includes('?') ? '&' : '?';
      const past = await api('GET', `${statsEp.path}${sep}from=2020-01-01&to=2020-01-31&start_date=2020-01-01&end_date=2020-01-31&from_date=2020-01-01&to_date=2020-01-31`, { role: 'technician' });
      const pastBody = JSON.stringify(past.json || past.text || '');
      const excluded = !( /\b60\b|"60"/.test(pastBody) && (pastBody.includes(String(machineId)) || pastBody.includes(marker)) );
      filteredOk = past.status === 200 && excluded;
      filterDetail = `HTTP ${past.status} excludedFromPastRange=${excluded}`;
    }
    actions.push({
      name: 'date-range filter excludes out-of-range events',
      ok: filteredOk,
      detail: filterDetail,
    });

    return actions;
  },
};
