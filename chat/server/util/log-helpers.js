/**
 * `logAndSwallow(err, label, fallback?)` — formalizes the log-and-swallow
 * pattern that previously lived as ~33 try-catch sites across chat/server.
 *
 * Reason for centralizing: error-swallowing is correct in many places
 * (best-effort validators, optional metadata reads, advisory MGA calls)
 * but a silent or inconsistent catch can hide real regressions. A single
 * helper guarantees:
 *   - every swallowed error is logged via `terr` (timestamped stderr —
 *     the spike's convention) with a uniform `<label>: <message>` shape.
 *   - the fallback is explicit at the call site, not buried in
 *     post-catch control flow.
 *
 * Use when: you intentionally want execution to continue after a thrown
 * error, but the failure should still be visible in logs.
 *
 * Do NOT use when:
 *   - the catch participates in business logic (retry counters,
 *     state mutation, control flow that branches on err.kind).
 *   - the swallow is deliberately silent (file-not-found probes,
 *     parser-on-non-target-file). Those stay as `try { ... } catch {}`.
 *
 * Optional `fallback` is returned so the helper composes with
 * `return logAndSwallow(err, 'label', defaultValue);` one-liners.
 */
import { terr } from './timestamped-log.js';

export function logAndSwallow(err, label, fallback) {
  terr('%s: %s', label, err?.message || String(err));
  return fallback;
}
