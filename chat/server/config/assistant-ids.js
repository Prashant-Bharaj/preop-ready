import { readFileSync } from 'node:fs';
import { ASSISTANTS_CONFIG_PATH } from '../core/paths.js';

export const HARNESS_ASSISTANT_KEYS = [
  'subagentDatabaseAssistantId',
  'subagentBackendAssistantId',
  'subagentFrontendAssistantId',
  'subagentVectordbAssistantId',
  'subagentIntegrationAssistantId',
  'reconcilerJudgeAssistantId',
  'promptWriterAssistantId',
  'routerAssistantId',
  'summarizerAssistantId',
  'understandingAssistantId',
  'contractAssistantId',
  'conciergeAssistantId',
];

export function envVarFor(camelKey) {
  return camelKey.replace(/([A-Z])/g, '_$1').toUpperCase().replace(/^_/, '');
}

let cached = null;

export function loadAssistantIds() {
  if (cached) return cached;
  const raw = readFileSync(ASSISTANTS_CONFIG_PATH, 'utf-8');
  cached = JSON.parse(raw);
  return cached;
}

export function reloadAssistantIds() {
  cached = null;
  return loadAssistantIds();
}
