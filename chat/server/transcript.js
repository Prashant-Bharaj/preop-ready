import { appendFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { TRANSCRIPTS_DIR } from './paths.js';

function ensureDir() {
  if (!existsSync(TRANSCRIPTS_DIR)) {
    mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
  }
}

export function appendEvent(sessionId, type, payload) {
  ensureDir();
  const record = { ts: Date.now(), type, payload };
  const filePath = path.join(TRANSCRIPTS_DIR, `${sessionId}.jsonl`);
  appendFileSync(filePath, JSON.stringify(record) + '\n');
  return record;
}

export function readTail(sessionId, n = 100) {
  const filePath = path.join(TRANSCRIPTS_DIR, `${sessionId}.jsonl`);
  if (!existsSync(filePath)) return [];
  const lines = readFileSync(filePath, 'utf-8').trim().split('\n').filter(Boolean);
  return lines.slice(-n).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}
