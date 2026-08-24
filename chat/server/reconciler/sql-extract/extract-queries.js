// extract-queries.js — language dispatcher for backend SQL extraction.
// Picks the per-language AST extractor by the same runtime detection the
// type-gate uses (node vs python). Returns the merged static-query list
// [{ sql, file, line }]. Empty (fail-open) when there's no backend / no
// detectable runtime.

import path from 'node:path';
import { detectRuntime } from '../type-gate.js';
import { extractNodeQueries } from './extract-node.js';
import { extractPythonQueries } from './extract-python.js';

export function extractBackendQueries(workspaceDir) {
  const backendDir = path.join(workspaceDir, 'backend');
  const runtime = detectRuntime(workspaceDir, 'backend');
  if (runtime === 'python') return extractPythonQueries(backendDir);
  // 'node' or null (detection imperfect but it's almost always a JS/TS backend):
  // the Node extractor is safe — it only matches `.query(...)` literals.
  return extractNodeQueries(backendDir);
}
