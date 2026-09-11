import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// In Docker: WORKSPACE_DIR=/workspace, chat app at /opt/chat
// In local dev: WORKSPACE_DIR defaults to repo root (three levels up from chat/server/core/)
export const WORKSPACE_DIR = path.resolve(
  process.env.WORKSPACE_DIR || path.join(__dirname, '..', '..', '..')
);
export const CHAT_APP_DIR = path.resolve(__dirname, '..', '..');
export const CHAT_DATA_DIR = path.resolve(WORKSPACE_DIR, '.chat');
export const SECRETS_PATH = path.join(CHAT_DATA_DIR, 'secrets.json');
export const ASSISTANTS_CONFIG_PATH = path.join(CHAT_APP_DIR, 'server', 'config', 'assistants.json');
export const TRANSCRIPTS_DIR = path.join(CHAT_DATA_DIR, 'transcripts');
export const STATIC_DIR = path.join(CHAT_APP_DIR, 'dist');
