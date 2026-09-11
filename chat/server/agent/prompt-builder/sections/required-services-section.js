/**
 * Build the "=== REQUIRED SERVICES ===" section for the integration agent.
 * Step 7e runtime guard: when the orchestrator's <task> prose to the integration
 * agent collapses two scopes (e.g., merges database+vectordb when both run
 * pgvector), the integration agent only sees the prose and follows it.
 * This section gives the integration agent a deterministic, authoritative
 * list of every service scope the router emitted — independent of what the
 * orchestrator wrote. Integration agent cross-checks orch prose vs. this list
 * and adds missing services if they disagree.
 *
 * Populated from the canonical task list (router output, persisted via
 * orchestration-stash and surfaced to scope agents via the orchestrator's
 * spawn handler). Service scopes are {database, vectordb, backend,
 * frontend, nextjs} — integration/docs/fullstack are not "services"
 * themselves.
 */
export function buildRequiredServicesSection(allTaskScopes, scope) {
  if (scope !== 'integration') return null;
  if (!Array.isArray(allTaskScopes) || allTaskScopes.length === 0) return null;
  const SERVICE_SCOPES = new Set(['database', 'vectordb', 'backend', 'frontend', 'nextjs']);
  const services = allTaskScopes.filter(s => SERVICE_SCOPES.has(s));
  if (services.length === 0) return null;
  return (
    '=== REQUIRED SERVICES ===\n' +
    `Authoritative service list from the router: ${services.join(', ')}\n\n` +
    'Your docker-compose.yml MUST contain ONE service block per name above, named EXACTLY by the scope name. This list comes directly from the router — if your `=== YOUR TASK ===` section\'s prose lists fewer services, the orchestrator collapsed scopes and YOU MUST fill in the missing services.\n\n' +
    'Hard rule: even when two services use the same engine (e.g., database + vectordb both run pgvector), they are STILL two separate services with separate Dockerfile build contexts (`./database/` and `./vectordb/`). Do NOT merge by mounting one\'s init scripts into the other\'s container — that violates platform deployment topology (separate ECS services, separate EFS mounts).'
  );
}
