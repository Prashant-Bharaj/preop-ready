/**
 * Flag resolver — merges feature-flag-derived rules and snippets into each
 * task the router produced.
 *
 * Called in session/routes.js right after parseRouterJSON returns, before the plan
 * is held for user confirmation. Looks at `plan.flags` (emitted by the
 * router) and for every task in `plan.tasks` calls resolveContext to find
 * matching tagged files, then unions them into task.rules[] / task.snippets[].
 *
 * This keeps the router's job small (emit flag names) while the backend owns
 * the flag → files mapping through snippet / rule frontmatter.
 *
 * Degraded mode: if resolveContext throws for any reason, the task is left
 * unchanged and the error is logged. The agent still works — prompt-builder
 * auto-hints scope rules via get_rules regardless.
 */

import { resolveContext } from '../../mcp/resolve-context.js';
import { WORKSPACE_DIR } from '../../core/paths.js';
import { logAndSwallow } from '../../util/log-helpers.js';

/**
 * Merge flag-resolved rules and snippets into every task of a plan.
 *
 * @param {{ flags?: string[], tasks?: Array<{scope,task,rules,snippets,summary}> }} plan
 * @returns {object} — the same plan shape with enriched task.rules / task.snippets.
 */
export function resolveFlags(plan) {
  if (!plan || !Array.isArray(plan.tasks) || plan.tasks.length === 0) {
    return plan;
  }

  const flags = Array.isArray(plan.flags) ? plan.flags : [];
  if (flags.length === 0 && plan.tasks.every(t => !hasScopeFor(t))) {
    // Nothing to resolve — no flags and no scopes we can match on.
    return plan;
  }

  const enrichedTasks = plan.tasks.map((task) => {
    try {
      const resolved = resolveContext({
        flags,
        scope: task.scope,
        workspaceDir: WORKSPACE_DIR,
      });

      const existingRules = Array.isArray(task.rules) ? task.rules : [];
      const existingSnippets = Array.isArray(task.snippets) ? task.snippets : [];

      const mergedRules = uniq([...existingRules, ...resolved.rules]);
      const mergedSnippets = uniq([...existingSnippets, ...resolved.snippets]);

      return { ...task, rules: mergedRules, snippets: mergedSnippets };
    } catch (err) {
      return logAndSwallow(err, `[flag-resolver] resolve failed for task scope=${task.scope}`, task);
    }
  });

  const totalRules = enrichedTasks.reduce((n, t) => n + (t.rules?.length || 0), 0);
  const totalSnippets = enrichedTasks.reduce((n, t) => n + (t.snippets?.length || 0), 0);
  console.log('[flag-resolver] merged flags=[%s] tasks=%d → rules=%d snippets=%d',
    flags.join(','), enrichedTasks.length, totalRules, totalSnippets);

  return { ...plan, tasks: enrichedTasks };
}

function hasScopeFor(task) {
  return typeof task?.scope === 'string' && task.scope.length > 0;
}

function uniq(arr) {
  return [...new Set(arr)];
}
