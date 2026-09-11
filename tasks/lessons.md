
## 2026-09-11 — a scratch-dir test ran in the user's main checkout (engine synced + deleted chat/)
Pattern: `cd "$SCRATCH/x" && setup; ...; bash scripts/apply-updates.sh ...; git commit ...` — the
scratch dir had been wiped by the OS, the first `cd` failed, and every later `;`-separated command
ran in the PRIMARY working directory (a real repo) instead. The template engine then synced the real
template into that checkout and its `cleanup: chat` entry deleted an untracked working folder.
Rules for myself:
1. Any multi-step test script starts with `cd "$DIR" || exit 1` AND runs under `set -e` in a
   subshell/script file — never a `;` chain after a `cd` that can fail.
2. Assert scratch fixtures exist (`[ -d "$S/template" ] || { echo missing; exit 1; }`) before use;
   /private/tmp scratch is wiped between days (see the tf-docs shim memory).
3. Never run the sync engine, `git checkout -- .`, `git clean`, or `git commit` from a script whose
   cwd is not asserted to be the fixture repo (`test "$(git rev-parse --show-toplevel)" = "$S/child"`).
4. Destructive git verbs in test scripts must be guarded by the same toplevel assertion.
