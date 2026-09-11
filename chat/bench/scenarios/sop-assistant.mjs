/**
 * Playbook Session 1 / Case 3 — RAG + uploads + roles (the SOP regression).
 * Actions: empty-state question (adversarial drill) → upload SOP as quality
 * → ask as technician → answer cites the SOP → role gate on upload.
 */

import { api, apiSmart, apiUpload, discoverEp, fill } from '../lib/app-client.mjs';

const SOP_DOC = (marker) => `SOP-BENCH-${marker} — Centrifuge Rotor Inspection
Department: Quality Control
Review Date: 2027-01-01

1. PURPOSE
Defines rotor inspection for benchtop centrifuges.

2. INSPECTION STEPS
2.1 Remove the rotor and inspect for corrosion.
2.2 The rotor must be replaced after 9000 run hours or five years, whichever comes first.
2.3 Record the inspection in the equipment logbook.

3. REFERENCES
- SOP-QA-001 Document Control
`;

export default {
  name: 'sop-assistant',
  prompt: 'Build an SOP assistant for our quality team: they upload SOPs and work instructions as documents, and lab technicians ask questions in plain language. Answers must cite the specific SOP name and section they came from. Show a warning on any answer that cites an SOP whose review date has passed.',

  answerClarify() {
    return [
      'Quality team uploads and maintains SOPs; technicians only ask questions.',
      'SOP metadata: review date, department, document owner, version.',
      'Yes, log every question with who asked it.',
      'No extras — no email alerts, no dashboard.',
    ].join(' ');
  },

  expectations: { aiApp: true },

  async threeAction(marker) {
    const actions = [];

    // Adversarial drill: question BEFORE any document exists — graceful
    // answer or clean 4xx, never a 5xx.
    const askEp = discoverEp('POST', /question|ask|query/i);
    const empty = askEp
      ? await apiSmart('POST', askEp.path, { role: 'technician', spec: askEp.request, marker, overrides: { question: 'What is the rotor replacement interval?', question_text: 'What is the rotor replacement interval?' }, timeoutMs: 120_000 })
      : { status: -1, text: 'no question endpoint in contract' };
    actions.push({
      name: 'empty-state question handled gracefully (no 5xx)',
      ok: empty.status > 0 && empty.status < 500,
      detail: `HTTP ${empty.status} ${(empty.text || '').slice(0, 80)}`,
    });

    // Upload the SOP as quality team (multipart). The multipart field name
    // comes from the CONTRACT (the request field typed file/multipart);
    // conventional names are fallbacks. A wrong name surfaces as multer's
    // "Unexpected field" — apps wrap it as 400/422 OR an unhandled 500, so
    // the retry keys on the message, not the status.
    const uploadEp = discoverEp('POST', /sop|document|upload/i);
    const specFileField = uploadEp
      ? (Object.entries(uploadEp.request || {}).find(([, v]) => /file|multipart/i.test(String(v)))?.[0] ?? null)
      : null;
    const fieldCandidates = [...new Set([specFileField, 'file', 'document', 'sop'].filter(Boolean))];
    // Text fields are ADAPTIVE: contracts vary the metadata field names
    // (version vs version_number, review_date vs effective_date, …), and a
    // hardcoded set 400s on whatever this roll named required. Seed sensible
    // values, then read the app's own "X: Required" validation errors and
    // fill the missing fields — the same behavior-driven retry the JSON path
    // (apiSmart) has, which multipart never got.
    const seedFields = () => ({
      name: `SOP-BENCH-${marker}`, title: `SOP-BENCH-${marker}`,
      department: 'Quality Control', document_owner: 'Bench', owner: 'Bench',
      version: '1.0', version_number: '1.0',
      review_date: '2027-01-01', effective_date: '2027-01-01',
    });
    const fillRequired = (fields, res) => {
      const fe = res.json?.fields?.fieldErrors || res.json?.fieldErrors;
      if (!fe) return false;
      let added = false;
      for (const [f, errs] of Object.entries(fe)) {
        if (!/required/i.test(String(errs)) || f in fields) continue;
        fields[f] = /date/i.test(f) ? '2027-01-01'
          : /number|count|qty|version/i.test(f) ? '1'
            : `Bench ${f} ${marker}`;
        added = true;
      }
      return added;
    };
    let uploadFinal = { status: -1, text: 'no upload endpoint in contract' };
    if (uploadEp) {
      for (const fileField of fieldCandidates) {
        const fields = seedFields();
        for (let attempt = 0; attempt < 4; attempt++) {
          uploadFinal = await apiUpload(uploadEp.path, {
            role: 'quality_team', fields,
            file: { name: `SOP-BENCH-${marker}.txt`, content: SOP_DOC(marker) },
            fileField,
          });
          if (uploadFinal.status >= 200 && uploadFinal.status < 300) break;
          if (!fillRequired(fields, uploadFinal)) break; // nothing more to add
        }
        if (uploadFinal.status >= 200 && uploadFinal.status < 300) break;
        const fieldMismatch = /unexpected field|no file|file.*(required|missing)/i.test(uploadFinal.text || '');
        if (!fieldMismatch) break; // a non-field-name error — trying other file-field names won't help
      }
    }
    actions.push({
      name: 'quality_team uploads SOP document',
      ok: uploadFinal.status >= 200 && uploadFinal.status < 300,
      detail: `HTTP ${uploadFinal.status} ${(uploadFinal.text || '').slice(0, 100)}`,
    });

    // Ask as technician; the answer must reference our SOP (real retrieval).
    // Apps may index uploads ASYNCHRONOUSLY (upload 201s, embeddings finish
    // seconds later — observed live: "Processing embeddings for SOP 1...").
    // A real user pauses between uploading and asking; the bench retries the
    // ask a few times before calling retrieval broken.
    let ask = { status: -1, ms: 0, text: 'no question endpoint' };
    let answerText = '';
    let cites = false;
    if (askEp) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        ask = await apiSmart('POST', askEp.path, { role: 'technician', spec: askEp.request, marker, overrides: { question: 'After how many run hours must the centrifuge rotor be replaced?', question_text: 'After how many run hours must the centrifuge rotor be replaced?' }, timeoutMs: 150_000 });
        answerText = JSON.stringify(ask.json || ask.text || '');
        cites = answerText.includes(`SOP-BENCH-${marker}`) || /9[,.]?000/.test(answerText);
        if (cites || ask.status >= 300) break;
        await new Promise((r) => setTimeout(r, 8000));
      }
    }
    actions.push({
      name: 'technician question answered from the uploaded SOP (citation/facts)',
      ok: ask.status < 300 && cites && ask.ms > 2000,
      detail: `HTTP ${ask.status} in ${ask.ms}ms citesOurSop=${answerText.includes(`SOP-BENCH-${marker}`)} hasFact=${/9[,.]?000/.test(answerText)}`,
    });

    // Role gate: technician must not be able to upload. Send a fully VALID
    // payload (seed fields) so the ONLY reason to reject is the role — an
    // incomplete payload tripped body-validation (400) first and MASKED
    // whether the gate exists at all (observed: a 400 hid a real hole — the
    // app happily accepted a technician upload, 201, when the payload was
    // complete). A 2xx here is a genuine authz defect, not a bench miss.
    const gate = uploadEp
      ? await apiUpload(uploadEp.path, {
          role: 'technician',
          fields: { ...seedFields(), name: `SOP-FORBIDDEN-${marker}`, title: `SOP-FORBIDDEN-${marker}` },
          file: { name: 'x.txt', content: 'nope' },
          fileField: fieldCandidates[0],
        })
      : { status: -1, text: 'n/a' };
    const uploaded = gate.status >= 200 && gate.status < 300;
    actions.push({
      name: 'role gate: technician blocked from uploading',
      ok: gate.status === 401 || gate.status === 403,
      detail: uploaded
        ? `HTTP ${gate.status} — AUTHZ DEFECT: technician uploaded an SOP (rule "technicians only ask questions" not enforced)`
        : `HTTP ${gate.status} (expected 401/403)`,
    });

    return actions;
  },
};