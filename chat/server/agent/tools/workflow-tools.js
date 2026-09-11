/**
 * Workflow tool handlers — agent-loop pass-throughs.
 *
 * task_progress streams a progress marker; attempt_completion signals
 * "done" to the agent loop by returning null (every other tool returns a
 * string that gets fed back to the model).
 */

// ── task_progress (pass-through) ──

export async function toolTaskProgress(params, { emit }) {
  const text = params.task_progress || '';
  emit({ say: 'task_progress', text });
  // No response needed — progress is informational
  return '(progress recorded)';
}

// ── attempt_completion (terminal) ──

export async function toolAttemptCompletion(params, { emit }) {
  const result = params.result || '';
  emit({ say: 'completion_result', text: result });
  return null; // signals "done" to the agent loop
}
