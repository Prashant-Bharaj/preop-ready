export function buildDefinitionOfDone(scopes) {
  const lines = [
    '=== DEFINITION OF DONE ===',
    'Emit `attempt_completion` as soon as ALL of these are true:',
    '',
    '1. The files required by the task exist with correct content (use `write_to_file` / `replace_in_file`, then trust your own writes — do not re-read to "double-check" without a concrete reason).',
    '2. If code needs runtime deps, `npm install` (or equivalent) has been run and returned exit 0.',
    '3. If a quick smoke test is reasonable, it shows the process starting cleanly (e.g. `Backend listening on port 3000`). That is sufficient evidence for simple endpoint / file additions.',
    '',
    'What "done" is NOT:',
    '- Testing every branch of every endpoint via curl/http.get is NOT required. Do not keep writing more elaborate verification scripts.',
    '- Re-reading files you just wrote is NOT part of being done. If write_to_file succeeded, the file is on disk.',
    '- "I will verify once more to be sure" is a trap. If you wrote the right code and the process starts, you are done.',
    '',
    'Anti-loop rule: if your last 2 responses have not produced a new write/edit/command AND you have not emitted attempt_completion, something is wrong. Either:',
    '  (a) emit attempt_completion now with what you have, OR',
    '  (b) emit attempt_completion explaining what specific blocker you cannot resolve.',
  ];
  return lines.join('\n');
}
