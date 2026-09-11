#!/usr/bin/env node
/**
 * Rule Adapter Generator
 *
 * .platform-rules/ is the ONLY place platform rules are edited. This script
 * generates every per-tool adapter from those canonical files plus their
 * frontmatter (description / triggers / globs):
 *
 *   .github/copilot-instructions.md        core mirror (Copilot can't import)
 *   .clinerules/00-core.md                 core mirror (Cline auto-loads its folder)
 *   .clinerules/01-router.md               trigger -> file table (Cline + Claude import)
 *   .claude/skills/<name>/SKILL.md         Claude Code on-demand picking
 *   .cursor/rules/000-core.mdc             Cursor always-on core
 *   .cursor/rules/<name>.mdc               Cursor glob-attached / agent-requested
 *   .github/instructions/<name>.instructions.md   Copilot path-scoped (full body:
 *                                          loaded only when applyTo matches)
 *
 * Run in the template repo only (children receive the generated output via
 * template sync). `--check` regenerates in memory and exits 1 on drift —
 * wired into version-bump.yml so a hand-edited adapter fails CI.
 *
 * Frontmatter contract (rigid):
 *   ---
 *   description: "one line"
 *   triggers: ["phrase", ...]
 *   globs: ["glob", ...]
 *   ---
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const RULES_DIR = path.join(ROOT, '.platform-rules');
const CHECK = process.argv.includes('--check');

const GENERATED_BANNER = (source) =>
  `<!-- GENERATED FILE - DO NOT EDIT. Source: ${source} -->\n` +
  `<!-- Regenerate: node scripts/build-rule-adapters.js -->\n\n`;

function fail(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

function parseRuleFile(absPath, relPath) {
  const raw = fs.readFileSync(absPath, 'utf8');
  const m = raw.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) fail(`${relPath}: missing frontmatter`);
  const fm = m[1];
  const body = raw.slice(m[0].length).trim() + '\n';

  const desc = (fm.match(/^description:\s*"(.*)"\s*$/m) || [])[1];
  if (!desc) fail(`${relPath}: frontmatter needs description: "..."`);

  const listOf = (key) => {
    const line = fm.match(new RegExp(`^${key}:\\s*\\[(.*)\\]\\s*$`, 'm'));
    if (!line) return [];
    return line[1]
      .split(',')
      .map((s) => s.trim().replace(/^"|"$/g, ''))
      .filter(Boolean);
  };

  return {
    rel: relPath,
    name: path.basename(relPath, '.md'),
    description: desc,
    triggers: listOf('triggers'),
    globs: listOf('globs'),
    body,
  };
}

function collectRules() {
  const rules = { core: [], scope: [], reference: [], other: [] };
  for (const f of fs.readdirSync(RULES_DIR).sort()) {
    const abs = path.join(RULES_DIR, f);
    if (fs.statSync(abs).isDirectory()) continue;
    if (!f.endsWith('.md')) continue;
    const rule = parseRuleFile(abs, `.platform-rules/${f}`);
    if (/^\d\d-/.test(f)) rules.core.push(rule);
    else if (f.startsWith('scope-')) rules.scope.push(rule);
    else rules.other.push(rule);
  }
  const refDir = path.join(RULES_DIR, 'reference');
  if (fs.existsSync(refDir)) {
    for (const f of fs.readdirSync(refDir).sort()) {
      if (!f.endsWith('.md')) continue;
      rules.reference.push(
        parseRuleFile(path.join(refDir, f), `.platform-rules/reference/${f}`)
      );
    }
  }
  if (rules.core.length === 0) fail('no core files (.platform-rules/NN-*.md) found');
  return rules;
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function buildCoreBlock(rules) {
  return rules.core.map((r) => r.body).join('\n---\n\n');
}

function buildRouterTable(rules) {
  const rows = [];
  for (const r of [...rules.scope, ...rules.other, ...rules.reference]) {
    if (r.triggers.length === 0) continue;
    rows.push(`| ${r.triggers.join(', ')} | \`${r.rel}\` |`);
  }
  return [
    '## When the user says... read this FIRST',
    '',
    '| User intent / trigger | Read |',
    '|---|---|',
    ...rows,
    '| any new feature request | `snippets/INDEX.md` (ALWAYS check before writing code) |',
    '| editing nginx / Dockerfile / docker-compose | `.platform-rules/scope-integration.md` |',
    '',
  ].join('\n');
}

function buildCopilotInstructions(rules) {
  return (
    GENERATED_BANNER('.platform-rules/00-*.md + 01-*.md + 02-*.md') +
    '# Vibe Hackathon Platform — AI Rules (Copilot)\n\n' +
    'You are a friendly AI coding mentor helping hackathon participants build their apps.\n\n' +
    buildCoreBlock(rules) +
    '\n---\n\n' +
    buildRouterTable(rules) +
    '\nOpen and follow the referenced file before acting on a matching request.\n'
  );
}

function buildClineCore(rules) {
  return (
    GENERATED_BANNER('.platform-rules/00-*.md + 01-*.md + 02-*.md') +
    '# Vibe Hackathon Platform — Core Rules (Cline)\n\n' +
    'You are a friendly AI coding mentor helping hackathon participants build their apps.\n\n' +
    buildCoreBlock(rules)
  );
}

function buildClineRouter(rules) {
  return (
    GENERATED_BANNER('frontmatter triggers of all .platform-rules files') +
    '# Rule Router\n\n' +
    buildRouterTable(rules) +
    '\nRead the referenced file with your file tools before acting on a matching request.\n'
  );
}

function buildSkill(rule) {
  const skillName = rule.name.replace(/^scope-/, '');
  return [
    '---',
    `name: ${skillName}`,
    `description: ${rule.description}`,
    '---',
    '',
    `Read \`${rule.rel}\` and follow it exactly. It is the canonical platform rule`,
    'for this topic; it links the code snippets to copy instead of writing from scratch.',
    '',
    'Also honor the always-on core rules (imported via CLAUDE.md) — they override',
    'anything that conflicts.',
    '',
  ].join('\n');
}

function buildCursorCore(rules) {
  return [
    '---',
    'description: Vibe Hackathon platform core rules (always apply)',
    'alwaysApply: true',
    '---',
    '',
    GENERATED_BANNER('.platform-rules/00-*.md + 01-*.md + 02-*.md').trim(),
    '',
    buildCoreBlock(rules),
    '',
    buildRouterTable(rules),
  ].join('\n');
}

function buildCursorRule(rule) {
  const lines = ['---', `description: ${rule.description}`];
  if (rule.globs.length > 0) lines.push(`globs: ${rule.globs.join(',')}`);
  lines.push('alwaysApply: false', '---', '');
  lines.push(
    `@${rule.rel}`,
    '',
    `Follow \`${rule.rel}\` (inlined above) exactly for this area. The always-on`,
    'core rules still apply and win on conflict.',
    ''
  );
  return lines.join('\n');
}

function buildCopilotInstructionFile(rule) {
  return [
    '---',
    `applyTo: "${rule.globs.join(',')}"`,
    '---',
    '',
    GENERATED_BANNER(rule.rel).trim(),
    '',
    rule.body,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Output assembly
// ---------------------------------------------------------------------------

function assembleOutputs(rules) {
  const out = new Map();
  out.set('.github/copilot-instructions.md', buildCopilotInstructions(rules));
  out.set('.clinerules/00-core.md', buildClineCore(rules));
  out.set('.clinerules/01-router.md', buildClineRouter(rules));
  out.set('.cursor/rules/000-core.mdc', buildCursorCore(rules));

  for (const r of [...rules.scope, ...rules.other, ...rules.reference]) {
    const stem = r.name.replace(/^scope-/, '');
    out.set(`.claude/skills/${stem}/SKILL.md`, buildSkill(r));
    out.set(`.cursor/rules/${stem}.mdc`, buildCursorRule(r));
    if (r.globs.length > 0) {
      out.set(`.github/instructions/${stem}.instructions.md`, buildCopilotInstructionFile(r));
    }
  }
  return out;
}

function main() {
  const rules = collectRules();
  const outputs = assembleOutputs(rules);

  // Stale-output sweep: generated trees must contain only current outputs
  const generatedDirs = ['.claude/skills', '.cursor/rules', '.github/instructions'];

  if (CHECK) {
    let drift = false;
    for (const [rel, content] of outputs) {
      const abs = path.join(ROOT, rel);
      if (!fs.existsSync(abs) || fs.readFileSync(abs, 'utf8') !== content) {
        console.error(`STALE: ${rel}`);
        drift = true;
      }
    }
    for (const dir of generatedDirs) {
      const abs = path.join(ROOT, dir);
      if (!fs.existsSync(abs)) continue;
      for (const f of walk(abs)) {
        // Normalize to forward slashes: the `outputs` keys use '/', but
        // path.relative() yields '\' on Windows, which would falsely orphan
        // every adapter.
        const rel = path.relative(ROOT, f).split(path.sep).join('/');
        if (!outputs.has(rel)) {
          console.error(`ORPHAN: ${rel} (no matching .platform-rules source)`);
          drift = true;
        }
      }
    }
    if (drift) {
      console.error('\nAdapters are out of date. Run: node scripts/build-rule-adapters.js');
      process.exit(1);
    }
    console.log(`OK: ${outputs.size} adapters current`);
    return;
  }

  // A gitignored output would be silently dropped from commits and never reach
  // child repos (this bit us: secrets/ matched .claude/skills/secrets/).
  const { execFileSync } = require('child_process');
  for (const rel of outputs.keys()) {
    try {
      const hit = execFileSync('git', ['check-ignore', '-v', rel], { cwd: ROOT }).toString().trim();
      fail(`output ${rel} is gitignored (${hit}) — rename the source file or adjust .gitignore`);
    } catch (e) {
      if (e.status !== 1) throw e; // 1 = not ignored (good); anything else is a real error
    }
  }

  for (const dir of generatedDirs) {
    fs.rmSync(path.join(ROOT, dir), { recursive: true, force: true });
  }
  for (const [rel, content] of outputs) {
    const abs = path.join(ROOT, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    console.log(`wrote ${rel}`);
  }
  console.log(`\n${outputs.size} adapters generated from ${rules.core.length + rules.scope.length + rules.other.length + rules.reference.length} canonical files`);
}

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(abs);
    else yield abs;
  }
}

main();
