import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { CHAT_DATA_DIR, TRANSCRIPTS_DIR } from '../core/paths.js';

const INDEX_PATH = path.join(CHAT_DATA_DIR, 'sessions.json');

/**
 * Read the session index from disk.
 * Returns an array of session metadata objects.
 */
export function readIndex() {
  if (!existsSync(INDEX_PATH)) return [];
  try {
    return JSON.parse(readFileSync(INDEX_PATH, 'utf-8'));
  } catch {
    return [];
  }
}

/**
 * Write the full session index to disk.
 */
function writeIndex(sessions) {
  if (!existsSync(CHAT_DATA_DIR)) {
    mkdirSync(CHAT_DATA_DIR, { recursive: true });
  }
  writeFileSync(INDEX_PATH, JSON.stringify(sessions, null, 2));
}

/**
 * Add or update a session entry in the index.
 */
export function upsertSession({ sessionId, title, createdAt, lastMessageAt }) {
  const sessions = readIndex();
  const existing = sessions.find(s => s.sessionId === sessionId);
  if (existing) {
    if (title !== undefined && !existing.title) existing.title = title;
    if (lastMessageAt !== undefined) existing.lastMessageAt = lastMessageAt;
  } else {
    sessions.push({
      sessionId,
      title: title || null,
      createdAt: createdAt || Date.now(),
      lastMessageAt: lastMessageAt || Date.now(),
    });
  }
  writeIndex(sessions);
}

/**
 * List all sessions, sorted by most recent first.
 * Enriches index entries with a message count from the transcript file.
 */
export function listSessions() {
  const sessions = readIndex();

  // Also pick up orphaned transcripts not in the index (from before indexing was added)
  try {
    if (existsSync(TRANSCRIPTS_DIR)) {
      const files = readdirSync(TRANSCRIPTS_DIR).filter(f => f.endsWith('.jsonl'));
      for (const file of files) {
        const sessionId = file.replace('.jsonl', '');
        if (!sessions.find(s => s.sessionId === sessionId)) {
          // Extract metadata from the transcript itself
          const meta = extractTranscriptMeta(sessionId);
          if (meta) sessions.push(meta);
        }
      }
    }
  } catch { /* ignore */ }

  return sessions.sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0));
}

/**
 * Extract basic metadata from a transcript JSONL file.
 * Used for orphaned transcripts that predate the session index.
 */
function extractTranscriptMeta(sessionId) {
  const filePath = path.join(TRANSCRIPTS_DIR, `${sessionId}.jsonl`);
  if (!existsSync(filePath)) return null;
  try {
    const lines = readFileSync(filePath, 'utf-8').trim().split('\n').filter(Boolean);
    if (lines.length === 0) return null;

    const first = JSON.parse(lines[0]);
    const last = JSON.parse(lines[lines.length - 1]);

    // Find first real user message (not bootstrap)
    let title = null;
    for (const line of lines) {
      try {
        const evt = JSON.parse(line);
        if (evt.type === 'user' && evt.payload?.message && evt.payload?.source !== 'system') {
          title = evt.payload.message.slice(0, 80);
          break;
        }
      } catch { /* skip */ }
    }

    return {
      sessionId,
      title: title || 'Untitled session',
      createdAt: first.ts,
      lastMessageAt: last.ts,
    };
  } catch {
    return null;
  }
}

/**
 * Remove a session from the index.
 */
export function removeSession(sessionId) {
  const sessions = readIndex().filter(s => s.sessionId !== sessionId);
  writeIndex(sessions);
}

/**
 * Rename a session in the index (force-overwrite title).
 */
export function renameSession(sessionId, title) {
  const sessions = readIndex();
  const entry = sessions.find(s => s.sessionId === sessionId);
  if (entry) {
    entry.title = (title || '').trim().slice(0, 120) || 'Untitled session';
  }
  writeIndex(sessions);
}
