#!/usr/bin/env node
/**
 * End-to-end two-agent probe.
 *
 * For each test prompt:
 *  1. Phase 1 — UNDERSTANDING loop: send to PlannerAssistant, auto-press-A
 *     on each clarify, stop when it emits action="ready" with a brief, OR
 *     hit max-rounds killswitch (forces a final "build it now" turn).
 *  2. Phase 2 — CONTRACT call: send the brief as user content to the
 *     Contract Assistant, get back the full execute plan with contracts.
 *  3. Save full transcript + parsed plan to results/two-agent/.
 *
 * Standalone, no spike codebase impact. Reads same test-prompts.json the
 * single-prompt probe uses, so we can directly compare.
 *
 * Usage:
 *   node /Users/alen/www/bayer/deployment/planner-experiment/two-agent/probe-two-agent.js
 *   node ... --runs=3
 *   node ... --prompt-id=easy_policy_discovery
 *   node ... --max-rounds=5
 */
import fs from 'node:fs';
import path from 'node:path';

// Now living in chat/scripts/ of the spike repo. Paths are resolved
// relative to the spike root so the script is portable across checkouts.
// Results land in /tmp so they don't get accidentally committed.
const SPIKE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const PROMPT_BATTERY_PATH = path.join(SPIKE_ROOT, 'chat', 'tests', 'two-agent', 'test-prompts.json');
const RESULTS_DIR = '/tmp/two-agent-results';

const UNDERSTANDING_ID = '7c374394-b242-4c52-8e6a-7693f5328ac2';
const CONTRACT_ID = '232a5fbd-510b-4ca2-97ed-0bf6da2bfcb6';

const DEFAULT_N_RUNS = 1;
const DEFAULT_MAX_ROUNDS = 5;
const AUTO_A_RESPONSE = "A for each option.";
const KILLSWITCH_RESPONSE = "Just build it with what you have — emit the ready brief now, no more questions.";

function parseArgs(argv) {
  const opts = { nRuns: DEFAULT_N_RUNS, promptId: null, maxRounds: DEFAULT_MAX_ROUNDS };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--runs=')) opts.nRuns = Number(arg.slice('--runs='.length));
    else if (arg.startsWith('--prompt-id=')) opts.promptId = arg.slice('--prompt-id='.length);
    else if (arg.startsWith('--max-rounds=')) opts.maxRounds = Number(arg.slice('--max-rounds='.length));
  }
  return opts;
}

function loadSecrets() {
  const secretsPath = path.join(SPIKE_ROOT, '.chat', 'secrets.json');
  if (!fs.existsSync(secretsPath)) throw new Error(`secrets.json not found at ${secretsPath}`);
  const data = JSON.parse(fs.readFileSync(secretsPath, 'utf-8'));
  const baseUrl = process.env.OPENAI_COMPAT_BASE_URL || data.baseUrl;
  const apiKey = process.env.OPENAI_COMPAT_API_KEY || data.apiKey;
  if (!baseUrl || !apiKey) throw new Error('No baseUrl or apiKey resolved');
  return { baseUrl, apiKey };
}

function loadBattery() {
  if (!fs.existsSync(PROMPT_BATTERY_PATH)) throw new Error(`test-prompts.json not found at ${PROMPT_BATTERY_PATH}`);
  return JSON.parse(fs.readFileSync(PROMPT_BATTERY_PATH, 'utf-8'));
}

function extractContent(response) {
  if (typeof response?.choices?.[0]?.message?.content === 'string') return response.choices[0].message.content;
  if (typeof response?.content === 'string') return response.content;
  return null;
}

function tryParseJSON(content) {
  if (typeof content !== 'string') return null;
  const trimmed = content.trim();
  try { return JSON.parse(trimmed); } catch {}
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()); } catch {}
  }
  const start = trimmed.indexOf('{');
  if (start >= 0) {
    let depth = 0;
    for (let i = start; i < trimmed.length; i++) {
      if (trimmed[i] === '{') depth++;
      else if (trimmed[i] === '}') {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(trimmed.slice(start, i + 1)); } catch {}
          break;
        }
      }
    }
  }
  return null;
}

async function callAssistant({ assistantId, messages, baseUrl, apiKey }) {
  const body = {
    messages,
    assistant_id: assistantId,
    stream: false,
    hidden: true,
    tool_keys: [],
  };
  const url = `${baseUrl.replace(/\/$/, '')}/chat/agent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

async function runUnderstandingLoop({ originalUserMessage, baseUrl, apiKey, maxRounds }) {
  const messages = [{ role: 'user', content: originalUserMessage }];
  const rounds = [];
  let brief = null;
  let killswitchFired = false;

  for (let r = 1; r <= maxRounds + 1; r++) {  // +1 to allow killswitch turn
    const isKillswitch = r > maxRounds;
    const t0 = Date.now();
    let response;
    try {
      response = await callAssistant({ assistantId: UNDERSTANDING_ID, messages, baseUrl, apiKey });
    } catch (err) {
      rounds.push({ round: r, error: err.message, isKillswitch, ms: Date.now() - t0 });
      return { rounds, brief: null, killswitchFired, error: err.message };
    }
    const ms = Date.now() - t0;
    const content = extractContent(response);
    const parsed = tryParseJSON(content);
    rounds.push({ round: r, response, content, parsed, isKillswitch, ms });

    if (!parsed) {
      console.log(`    [round ${r}] PARSE_FAIL (${ms}ms)`);
      return { rounds, brief: null, killswitchFired, error: 'parse fail' };
    }

    if (parsed.action === 'ready') {
      console.log(`    [round ${r}] READY — brief emitted ${isKillswitch ? '(post-killswitch)' : ''} (${ms}ms)`);
      brief = parsed.brief;
      return { rounds, brief, killswitchFired };
    }

    if (parsed.action === 'clarify') {
      const msgPreview = (parsed.message || '').slice(0, 80).replace(/\n/g, ' ');
      console.log(`    [round ${r}] clarify — "${msgPreview}..." (${ms}ms)`);
      if (isKillswitch) {
        // Even with killswitch the agent didn't emit ready — give up
        console.log(`    [round ${r}] killswitch round still produced clarify; giving up`);
        return { rounds, brief: null, killswitchFired: true, error: 'killswitch did not produce ready' };
      }
      // Decide next user message
      let nextUserMsg;
      if (r >= maxRounds) {
        nextUserMsg = KILLSWITCH_RESPONSE;
        killswitchFired = true;
        console.log(`    [round ${r+1 > maxRounds ? '+killswitch' : ''}] firing killswitch`);
      } else {
        nextUserMsg = AUTO_A_RESPONSE;
      }
      messages.push({ role: 'assistant', content });
      messages.push({ role: 'user', content: nextUserMsg });
      continue;
    }

    // Unknown action
    console.log(`    [round ${r}] unknown action=${parsed.action}`);
    return { rounds, brief: null, killswitchFired, error: `unknown action: ${parsed.action}` };
  }

  return { rounds, brief: null, killswitchFired, error: 'exhausted rounds' };
}

async function runContractCall({ brief, baseUrl, apiKey }) {
  const userMessage = JSON.stringify(brief, null, 2);
  const t0 = Date.now();
  let response;
  try {
    response = await callAssistant({
      assistantId: CONTRACT_ID,
      messages: [{ role: 'user', content: userMessage }],
      baseUrl,
      apiKey,
    });
  } catch (err) {
    return { error: err.message, ms: Date.now() - t0 };
  }
  const ms = Date.now() - t0;
  const content = extractContent(response);
  const parsed = tryParseJSON(content);
  return { response, content, parsed, ms };
}

async function runOne({ prompt, baseUrl, apiKey, maxRounds, runIdx, total }) {
  const enrichedMessage = [
    '[Project Context]',
    `Environment: ${prompt.projectContext?.environment || 'Local'}`,
    `Phase: ${prompt.projectContext?.phase || 'empty'}`,
    `Structure: ${prompt.projectContext?.structure || 'none (fresh project)'}`,
    '',
    '[User Message]',
    prompt.userMessage,
  ].join('\n');

  console.log(`\n  Run ${runIdx}/${total} — Phase 1: Understanding loop`);
  const understanding = await runUnderstandingLoop({ originalUserMessage: enrichedMessage, baseUrl, apiKey, maxRounds });

  let contract = null;
  if (understanding.brief) {
    console.log(`  Run ${runIdx}/${total} — Phase 2: Contract agent`);
    contract = await runContractCall({ brief: understanding.brief, baseUrl, apiKey });
    if (contract.error) {
      console.log(`    [contract] ERROR: ${contract.error}`);
    } else if (!contract.parsed) {
      console.log(`    [contract] PARSE_FAIL (${contract.ms}ms)`);
    } else {
      const fp = contract.parsed;
      console.log(`    [contract] action=${fp.action} archetype=${fp.archetype||'OMIT'} scopes=[${(fp.tasks||[]).map(t=>t.scope).join(',')}] flags=[${(fp.flags||[]).join(',')}] tables=${fp.data_model?.tables?.length||0} endpoints=${fp.api_contract?.endpoints?.length||0} (${contract.ms}ms)`);
    }
  } else {
    console.log(`  Run ${runIdx}/${total} — SKIPPED Phase 2 (no brief)`);
  }

  return { understanding, contract };
}

async function main() {
  const opts = parseArgs(process.argv);
  const { baseUrl, apiKey } = loadSecrets();
  const battery = loadBattery();

  if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });

  const prompts = opts.promptId
    ? battery.prompts.filter(p => p.id === opts.promptId)
    : battery.prompts;
  if (prompts.length === 0) {
    console.error(`No prompts matched filter: ${opts.promptId}`);
    process.exit(1);
  }

  console.log('=== Two-agent probe ===');
  console.log(`UNDERSTANDING: ${UNDERSTANDING_ID}`);
  console.log(`CONTRACT:      ${CONTRACT_ID}`);
  console.log(`Prompts:       ${prompts.length}`);
  console.log(`Runs each:     ${opts.nRuns}`);
  console.log(`Max rounds:    ${opts.maxRounds} (killswitch on round ${opts.maxRounds + 1})`);
  console.log(`Results dir:   ${RESULTS_DIR}`);

  const allResults = {};

  for (const prompt of prompts) {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`PROMPT: ${prompt.id} — ${prompt.label}`);
    console.log('='.repeat(80));
    console.log(`User message: ${prompt.userMessage.slice(0, 120)}${prompt.userMessage.length > 120 ? '...' : ''}`);

    allResults[prompt.id] = [];
    for (let i = 1; i <= opts.nRuns; i++) {
      const result = await runOne({ prompt, baseUrl, apiKey, maxRounds: opts.maxRounds, runIdx: i, total: opts.nRuns });

      // Save full per-run result
      const outPath = path.join(RESULTS_DIR, `${prompt.id}.TWO_AGENT.run${i}.json`);
      fs.writeFileSync(outPath, JSON.stringify({
        prompt: { id: prompt.id, label: prompt.label, userMessage: prompt.userMessage },
        understanding: {
          rounds: result.understanding.rounds.map(r => ({
            round: r.round,
            isKillswitch: r.isKillswitch,
            ms: r.ms,
            content: r.content,
            parsed: r.parsed,
            error: r.error,
          })),
          brief: result.understanding.brief,
          killswitchFired: result.understanding.killswitchFired,
          error: result.understanding.error,
        },
        contract: result.contract ? {
          content: result.contract.content,
          parsed: result.contract.parsed,
          ms: result.contract.ms,
          error: result.contract.error,
        } : null,
      }, null, 2));

      allResults[prompt.id].push(result);
    }
  }

  // Summary
  console.log(`\n\n${'='.repeat(80)}`);
  console.log('SUMMARY');
  console.log('='.repeat(80));
  for (const prompt of prompts) {
    const runs = allResults[prompt.id];
    console.log(`\n${prompt.id}:`);
    for (let i = 0; i < runs.length; i++) {
      const r = runs[i];
      const rounds = r.understanding.rounds.length;
      const briefOk = !!r.understanding.brief;
      const ks = r.understanding.killswitchFired;
      const contractOk = !!r.contract?.parsed;
      console.log(`  Run ${i+1}: understanding=${rounds} rounds (brief=${briefOk?'OK':'FAIL'}${ks?', killswitch':''}) | contract=${contractOk?'OK':'FAIL'}`);
    }
  }

  console.log(`\nFull results: ${RESULTS_DIR}`);
}

main().catch((err) => {
  console.error('FATAL:', err.message || err);
  process.exit(1);
});
