import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// In Docker: WORKSPACE_DIR=/workspace, chat app at /opt/chat
// In local dev: WORKSPACE_DIR defaults to repo root (two levels up from chat/server/)
export const WORKSPACE_DIR = path.resolve(
  process.env.WORKSPACE_DIR || path.join(__dirname, '..', '..')
);
export const CHAT_APP_DIR = path.resolve(__dirname, '..');
export const CHAT_DATA_DIR = path.resolve(WORKSPACE_DIR, '.chat');
export const SECRETS_PATH = path.join(CHAT_DATA_DIR, 'secrets.json');
export const TRANSCRIPTS_DIR = path.join(CHAT_DATA_DIR, 'transcripts');
export const CLINE_DIR = path.join(CHAT_DATA_DIR, 'cline-data');
export const BOOTSTRAP_PATH = path.join(CHAT_APP_DIR, 'BOOTSTRAP_PROMPT.md');
export const STATIC_DIR = path.join(CHAT_APP_DIR, 'dist');
