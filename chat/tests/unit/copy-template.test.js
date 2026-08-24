import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// paths.js reads WORKSPACE_DIR at module-eval time. Set it BEFORE any import
// chain that touches it. All tests share one workspace; each test uses a
// unique sub-scope dir to stay isolated.
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-template-test-'));
process.env.WORKSPACE_DIR = WS;

const { dispatchTool, KNOWN_TOOL_NAMES } = await import('../../server/agent/tools/core.js');

after(() => {
  fs.rmSync(WS, { recursive: true, force: true });
});

function mkEmit() {
  const events = [];
  const emit = (e) => events.push(e);
  return { emit, events };
}

function clean(scope) {
  const abs = path.join(WS, scope);
  fs.rmSync(abs, { recursive: true, force: true });
  fs.mkdirSync(abs, { recursive: true });
}

test('copy_template: byte-identical copy from <scope>/<template>', async () => {
  clean('test1');
  const sourceContent = 'FROM dd-kitchen-sink:local\nWORKDIR /app\nCMD ["node", "src/index.js"]\n';
  fs.writeFileSync(path.join(WS, 'test1', 'Dockerfile.node'), sourceContent);

  const { emit, events } = mkEmit();
  const result = await dispatchTool(
    'copy_template',
    { template: 'Dockerfile.node', dest: 'test1/Dockerfile' },
    { emit },
  );

  const written = fs.readFileSync(path.join(WS, 'test1', 'Dockerfile'), 'utf-8');
  assert.equal(written, sourceContent, 'destination must be byte-identical to source');
  assert.match(result, /Template copied/);

  const evt = events.find(e => e.say === 'tool');
  assert.ok(evt, 'must emit a tool event');
  const payload = JSON.parse(evt.text);
  assert.equal(payload.tool, 'copyTemplate');
  assert.equal(payload.template, 'Dockerfile.node');
  assert.equal(payload.dest, 'test1/Dockerfile');
  assert.equal(payload.source, path.join('test1', 'Dockerfile.node'));
});

test('copy_template: snippets fallback resolves nginx-production.conf', async () => {
  clean('test2');
  fs.rmSync(path.join(WS, 'snippets'), { recursive: true, force: true });
  const sourceContent = 'server { listen 8080; location / { try_files $uri /index.html; } }\n';
  fs.mkdirSync(path.join(WS, 'snippets', 'test2'), { recursive: true });
  fs.writeFileSync(path.join(WS, 'snippets', 'test2', 'nginx-production.conf'), sourceContent);

  const { emit, events } = mkEmit();
  await dispatchTool(
    'copy_template',
    { template: 'nginx-production.conf', dest: 'test2/nginx.conf' },
    { emit },
  );

  const written = fs.readFileSync(path.join(WS, 'test2', 'nginx.conf'), 'utf-8');
  assert.equal(written, sourceContent);
  const payload = JSON.parse(events.find(e => e.say === 'tool').text);
  assert.equal(payload.source, path.join('snippets', 'test2', 'nginx-production.conf'));
});

test('copy_template: missing template returns error naming both candidate paths', async () => {
  clean('test3');
  const { emit } = mkEmit();
  await assert.rejects(
    () => dispatchTool(
      'copy_template',
      { template: 'Dockerfile.does-not-exist', dest: 'test3/Dockerfile' },
      { emit },
    ),
    err => {
      assert.match(err.message, /Template 'Dockerfile\.does-not-exist' not found/);
      assert.match(err.message, /test3\/Dockerfile\.does-not-exist/);
      assert.match(err.message, /snippets\/test3\/Dockerfile\.does-not-exist/);
      assert.match(err.message, /Use write_to_file/);
      return true;
    },
  );
});

test('copy_template: path traversal in dest is rejected', async () => {
  clean('test4');
  fs.writeFileSync(path.join(WS, 'test4', 'Dockerfile.node'), 'x');
  const { emit } = mkEmit();
  await assert.rejects(
    () => dispatchTool(
      'copy_template',
      { template: 'Dockerfile.node', dest: '../escape/Dockerfile' },
      { emit },
    ),
    /Path escapes workspace/,
  );
});

test('copy_template: missing template param errors fast', async () => {
  const { emit } = mkEmit();
  await assert.rejects(
    () => dispatchTool('copy_template', { dest: 'x/Dockerfile' }, { emit }),
    /missing template/,
  );
  await assert.rejects(
    () => dispatchTool('copy_template', { template: 'Dockerfile.node' }, { emit }),
    /missing dest/,
  );
});

test('copy_template: idempotent - second copy of identical content emits unchanged', async () => {
  clean('test6');
  const sourceContent = 'CONTENT\n';
  fs.writeFileSync(path.join(WS, 'test6', 'Dockerfile.node'), sourceContent);

  const { emit: emit1 } = mkEmit();
  await dispatchTool(
    'copy_template',
    { template: 'Dockerfile.node', dest: 'test6/Dockerfile' },
    { emit: emit1 },
  );

  const { emit: emit2, events } = mkEmit();
  const result = await dispatchTool(
    'copy_template',
    { template: 'Dockerfile.node', dest: 'test6/Dockerfile' },
    { emit: emit2 },
  );

  assert.match(result, /no copy needed/);
  const payload = JSON.parse(events.find(e => e.say === 'tool').text);
  assert.equal(payload.unchanged, true);
});

test('copy_template: KNOWN_TOOL_NAMES includes copy_template', () => {
  assert.ok(KNOWN_TOOL_NAMES.includes('copy_template'), 'tool must be registered in TOOL_MAP');
});
