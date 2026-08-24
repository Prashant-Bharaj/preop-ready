/**
 * image-blocks — shared vision-block builder used by the planner + concierge.
 * Lets the model SEE uploaded images (mockups/screenshots) rather than just
 * their filename. SVG and non-images are excluded; unreadable files are skipped.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildImageBlocks, isVisionImage } from '../../server/agent/shared/image-blocks.js';

test('isVisionImage: png/jpeg/gif/webp yes; svg + non-images no', () => {
  for (const m of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) assert.equal(isVisionImage(m), true);
  for (const m of ['image/svg+xml', 'text/plain', 'application/pdf', null, undefined]) assert.equal(isVisionImage(m), false);
});

test('buildImageBlocks: encodes a real image to a base64 block, skips svg/text/missing', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'imgblk-'));
  fs.mkdirSync(path.join(ws, 'context'), { recursive: true });
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]); // arbitrary
  fs.writeFileSync(path.join(ws, 'context', 'shot.png'), bytes);
  const uploads = [
    { filename: 'shot.png', relativePath: 'context/shot.png', mime: 'image/png' },
    { filename: 'logo.svg', relativePath: 'context/logo.svg', mime: 'image/svg+xml' },   // skipped
    { filename: 'doc.md', relativePath: 'context/doc.md', mime: 'text/markdown' },         // skipped
    { filename: 'gone.png', relativePath: 'context/gone.png', mime: 'image/png' },         // missing → skipped
  ];
  try {
    const blocks = buildImageBlocks(uploads, ws, 'test');
    assert.equal(blocks.length, 1);
    // OpenAI image_url shape — the only one MGA's /chat/completions accepts.
    assert.equal(blocks[0].type, 'image_url');
    assert.equal(blocks[0].image_url.detail, 'high');
    assert.equal(blocks[0].image_url.url, `data:image/png;base64,${bytes.toString('base64')}`);
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('buildImageBlocks: no uploads / no images → [] (planner keeps plain string content)', () => {
  assert.deepEqual(buildImageBlocks(null, '/tmp', 't'), []);
  assert.deepEqual(buildImageBlocks([{ filename: 'a.txt', relativePath: 'a.txt', mime: 'text/plain' }], '/tmp', 't'), []);
});
