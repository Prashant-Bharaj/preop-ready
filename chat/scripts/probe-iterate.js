#!/usr/bin/env node
/**
 * probe-iterate.js — exercises contract-agent's iterate mode (Mode 2) by
 * feeding it synthetic prior_contract + failure_description inputs and saving
 * the response. Validates outputs against the iterate-mode rules in
 * chat/server/agent/planner/two-agent-parser.js.
 *
 * USAGE:
 *   node chat/scripts/probe-iterate.js                       # all scenarios
 *   node chat/scripts/probe-iterate.js --scenario=<id>       # one scenario
 *
 * Fixtures live in chat/tests/two-agent/iterate-fixtures.json; each scenario
 * references a prior_contract from chat/tests/two-agent/fixtures/.
 *
 * Outputs land in /tmp/iterate-results/<scenario_id>.json.
 *
 * This script is dev-only (not part of the runtime path). Phase B will wire
 * iterate mode into routes.js via runContractAgentWithRetry().
 */

import fs from 'node:fs';
import path from 'node:path';

import { parseAndValidateContract } from '../server/agent/planner/two-agent-parser.js';

const SPIKE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const FIXTURES_PATH = path.join(SPIKE_ROOT, 'chat', 'tests', 'two-agent', 'iterate-fixtures.json');
const RESULTS_DIR = '/tmp/iterate-results';

const CONTRACT_ID = '232a5fbd-510b-4ca2-97ed-0bf6da2bfcb6';

function parseArgs(argv) {
  const opts = { scenarioId: null };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--scenario=')) opts.scenarioId = arg.slice('--scenario='.length);
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

function extractContent(response) {
  if (typeof response?.choices?.[0]?.message?.content === 'string') return response.choices[0].message.content;
  if (typeof response?.content === 'string') return response.content;
  return null;
}

async function callContractAgent({ priorContract, failureDescription, baseUrl, apiKey }) {
  const input = { prior_contract: priorContract, failure_description: failureDescription };
  const body = {
    messages: [{ role: 'user', content: JSON.stringify(input, null, 2) }],
    assistant_id: CONTRACT_ID,
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

function loadPriorContract(relativePath) {
  const abs = path.join(SPIKE_ROOT, relativePath);
  if (!fs.existsSync(abs)) throw new Error(`prior contract not found: ${abs}`);
  const fixture = JSON.parse(fs.readFileSync(abs, 'utf-8'));
  if (!fixture.contract?.parsed) throw new Error(`fixture ${relativePath} has no .contract.parsed (likely an MGA-error fixture)`);
  return fixture.contract.parsed;
}

async function runScenario({ scenario, baseUrl, apiKey }) {
  console.log(`\n→ ${scenario.id}`);
  console.log(`  ${scenario.description}`);
  console.log(`  prior contract: ${scenario.prior_contract_path}`);

  const priorContract = loadPriorContract(scenario.prior_contract_path);
  const t0 = Date.now();
  let response, error;
  try {
    response = await callContractAgent({
      priorContract,
      failureDescription: scenario.failure_description,
      baseUrl,
      apiKey,
    });
  } catch (err) {
    error = err.message;
  }
  const ms = Date.now() - t0;

  if (error) {
    console.log(`  FAILED to call contract-agent (${ms}ms): ${error}`);
    return { scenario, error, ms };
  }

  const content = extractContent(response);
  const validation = parseAndValidateContract(content, null, { mode: 'iterate' });

  if (validation.ok) {
    console.log(`  PASS (${ms}ms) — action=${validation.contract.action} affected_scopes=[${validation.contract.affectedScopes.join(',')}]`);
  } else {
    console.log(`  FAIL VALIDATION (${ms}ms):`);
    for (const v of validation.violations) console.log(`    - ${v}`);
  }

  return { scenario, response, content, validation, ms };
}

async function main() {
  const opts = parseArgs(process.argv);
  const { baseUrl, apiKey } = loadSecrets();
  const fixtures = JSON.parse(fs.readFileSync(FIXTURES_PATH, 'utf-8'));
  const scenarios = opts.scenarioId
    ? fixtures.scenarios.filter(s => s.id === opts.scenarioId)
    : fixtures.scenarios;

  if (scenarios.length === 0) {
    console.error(`No scenarios matched${opts.scenarioId ? ` --scenario=${opts.scenarioId}` : ''}`);
    process.exit(1);
  }

  fs.mkdirSync(RESULTS_DIR, { recursive: true });

  let pass = 0, fail = 0, errored = 0;
  for (const scenario of scenarios) {
    const result = await runScenario({ scenario, baseUrl, apiKey });
    fs.writeFileSync(
      path.join(RESULTS_DIR, `${scenario.id}.json`),
      JSON.stringify(result, null, 2),
    );
    if (result.error) errored++;
    else if (result.validation?.ok) pass++;
    else fail++;
  }

  console.log(`\n=== ${pass} pass / ${fail} fail-validation / ${errored} errored / ${scenarios.length} total ===`);
  console.log(`Results: ${RESULTS_DIR}/`);
  process.exit(fail + errored > 0 ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
