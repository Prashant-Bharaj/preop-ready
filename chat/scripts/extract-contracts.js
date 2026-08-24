#!/usr/bin/env node
/**
 * For each {prompt-id}.{assistant}.run{N}.json under the probe results
 * dir, extract the final-turn parsed JSON and write a human-readable
 * markdown file with the full contracts.
 *
 * Reads results from /tmp/two-agent-results/ (where probe-two-agent.js
 * writes them) and outputs markdown to /tmp/two-agent-results/contracts-md/.
 */
import fs from 'node:fs';
import path from 'node:path';

const RESULTS_DIR = '/tmp/two-agent-results';
const OUTPUT_DIR = path.join(RESULTS_DIR, 'contracts-md');
if (!fs.existsSync(RESULTS_DIR)) {
  console.error(`No results found at ${RESULTS_DIR}. Run probe-two-agent.js first.`);
  process.exit(1);
}
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const files = fs.readdirSync(RESULTS_DIR)
  .filter(f => /\.run\d+\.json$/.test(f))
  .map(f => ({ file: f, dir: RESULTS_DIR }));

for (const { file, dir } of files) {
  const full = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
  // Three shapes: old single-turn (`response, parsed`), multi-turn (`turns`),
  // two-agent (`understanding, contract`).
  let finalParsed;
  let brief = null;
  let understandingRounds = null;
  if (full.understanding && full.contract) {
    finalParsed = full.contract.parsed;
    brief = full.understanding.brief;
    understandingRounds = full.understanding.rounds?.length;
  } else if (full.turns) {
    finalParsed = full.turns[full.turns.length - 1].parsed;
  } else {
    finalParsed = full.parsed;
  }
  if (!finalParsed) continue;

  const out = [];
  out.push(`# ${file.replace(/\.json$/, '')}\n`);
  out.push(`**Action:** ${finalParsed.action} | **Archetype:** ${finalParsed.archetype || 'OMIT'}\n`);
  out.push(`**Flags:** \`${(finalParsed.flags || []).join(', ') || '(none)'}\`\n`);

  if (full.turns) {
    out.push(`\n**Turns to reach this state:** ${full.turns.length}\n`);
  }
  if (understandingRounds != null) {
    out.push(`\n**Two-agent flow:** ${understandingRounds} understanding round(s) + 1 contract call\n`);
  }

  // Show the brief if two-agent format
  if (brief) {
    out.push(`\n## Brief (Understanding Agent → Contract Agent)\n`);
    out.push(`- **intent:** ${brief.intent || ''}`);
    out.push(`- **archetype:** ${brief.archetype || ''}`);
    out.push(`- **entities:** ${(brief.entities || []).join(', ')}`);
    out.push(`- **user_roles:** ${(brief.user_roles || []).join(', ')}`);
    out.push(`- **backend_language:** ${brief.stack_signals?.backend_language} (explicit_user_choice: ${brief.stack_signals?.explicit_user_choice})`);
    out.push(`- **flags:** \`${(brief.flags || []).join(', ')}\``);
    out.push(`- **capabilities_accepted:** ${(brief.capabilities_offered?.accepted || []).join(', ') || '(none)'}`);
    out.push(`- **capabilities_declined:** ${(brief.capabilities_offered?.declined || []).join(', ') || '(none)'}`);
    out.push(`- **capabilities_user_didnt_choose:** ${(brief.capabilities_offered?.user_didnt_choose || []).join(', ') || '(none)'}`);
    if (brief.key_workflows?.length) {
      out.push(`- **key_workflows:**`);
      brief.key_workflows.forEach(w => out.push(`  - ${w}`));
    }
    if (brief.notes_for_contract_agent) {
      out.push(`- **notes_for_contract_agent:** ${brief.notes_for_contract_agent}`);
    }
    out.push('');
  }

  // Tasks
  if (Array.isArray(finalParsed.tasks)) {
    out.push(`\n## Tasks (${finalParsed.tasks.length})\n`);
    for (const t of finalParsed.tasks) {
      out.push(`### [${t.scope}] ${t.summary || ''}`);
      out.push(`- **Dockerfile:** ${t.dockerfile || 'OMIT'}`);
      out.push(`- **primarySnippet:** ${t.primarySnippet || 'OMIT'}`);
      if (t.task) out.push(`- **task:** ${t.task}`);
      out.push('');
    }
  }

  // data_model
  if (finalParsed.data_model?.tables) {
    out.push(`\n## data_model (${finalParsed.data_model.tables.length} tables)\n`);
    for (const tbl of finalParsed.data_model.tables) {
      out.push(`### \`${tbl.name}\``);
      out.push('| Column | Type |');
      out.push('|---|---|');
      for (const col of (tbl.columns || [])) {
        out.push(`| ${col.name} | ${col.type} |`);
      }
      out.push('');
    }
  }

  // api_contract
  if (finalParsed.api_contract?.endpoints) {
    out.push(`\n## api_contract (${finalParsed.api_contract.endpoints.length} endpoints)\n`);
    if (finalParsed.api_contract.version != null) out.push(`Version: ${finalParsed.api_contract.version}`);
    if (Array.isArray(finalParsed.api_contract.frozen_endpoints) && finalParsed.api_contract.frozen_endpoints.length) {
      out.push(`Frozen endpoints: ${finalParsed.api_contract.frozen_endpoints.map(e => `\`${e.method} ${e.path}\``).join(', ')}`);
    }
    out.push('');
    out.push('| Method | Path | Request | Response |');
    out.push('|---|---|---|---|');
    for (const e of finalParsed.api_contract.endpoints) {
      const req = e.request ? '`' + JSON.stringify(e.request).slice(0, 80) + '`' : '–';
      const res = e.response ? `${e.response.status || '?'} \`${(e.response.body || '').slice(0, 80)}\`` : '–';
      out.push(`| ${e.method} | \`${e.path}\` | ${req} | ${res} |`);
    }
    out.push('');
  }

  // ui_contract
  if (finalParsed.ui_contract) {
    const uc = finalParsed.ui_contract;
    out.push(`\n## ui_contract\n`);
    out.push(`- **primary_view:** ${uc.primary_view}`);
    out.push(`- **primary_action:** ${uc.primary_action}`);
    if (uc.secondary_views?.length) out.push(`- **secondary_views:** ${uc.secondary_views.join(', ')}`);
    if (uc.components?.length) {
      out.push(`- **components (${uc.components.length}):**`);
      for (const c of uc.components) {
        out.push(`  - \`${c.name}\` — ${c.role}`);
      }
    }
    out.push('');
  }

  // business_logic_contract
  if (finalParsed.business_logic_contract) {
    const blc = finalParsed.business_logic_contract;
    out.push(`\n## business_logic_contract\n`);
    if (blc.triggers?.length) {
      out.push(`### Triggers (${blc.triggers.length})`);
      for (const t of blc.triggers) {
        out.push(`- **${t.event}** → ${t.action}${t.condition ? ` (when: ${t.condition})` : ''}`);
      }
      out.push('');
    }
    if (blc.rules?.length) {
      out.push(`### Rules (${blc.rules.length})`);
      for (const r of blc.rules) out.push(`- ${r}`);
      out.push('');
    }
    if (blc.side_effects?.length) {
      out.push(`### Side effects (${blc.side_effects.length})`);
      for (const s of blc.side_effects) out.push(`- ${s}`);
      out.push('');
    }
  }

  // mga_assistants
  if (finalParsed.mga_assistants?.length) {
    out.push(`\n## mga_assistants (${finalParsed.mga_assistants.length})\n`);
    out.push('| Key | Model | Description |');
    out.push('|---|---|---|');
    for (const a of finalParsed.mga_assistants) {
      out.push(`| ${a.key} | ${a.model} | ${(a.description || '').slice(0, 80)} |`);
    }
    out.push('');
  }

  const outPath = path.join(OUTPUT_DIR, file.replace(/\.json$/, '.md'));
  fs.writeFileSync(outPath, out.join('\n'));
}

console.log(`Wrote markdown files to ${OUTPUT_DIR} (from ${files.length} result files)`);