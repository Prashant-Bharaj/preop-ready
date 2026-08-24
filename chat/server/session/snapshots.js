/**
 * Per-session workspace snapshots backed by a hidden bare-git repo.
 *
 * Why a separate bare repo per session?
 *   - We must NEVER touch the user's real `.git/` directory (avoids the
 *     corruption / submodule / `.git_disabled` rename bugs documented against
 *     the Cline VSCode extension's checkpoint feature).
 *   - Per-session (not per-workspace) so that deleting a session deletes
 *     just its snapshot history, and branch operations on one session
 *     don't affect others.
 *
 * How we avoid touching `.git/`:
 *   - We never run git inside the workspace without `GIT_DIR` set.
 *   - `GIT_DIR=.chat/snapshots/<sid>.git` and `GIT_WORK_TREE=<workspace>`
 *     tell git to use the shadow bare repo but read/write files in the
 *     workspace. The workspace's own `.git/` is ignored.
 *   - `.chat/` is workspace-gitignored, so `git add -A` inside the
 *     workspace for our shadow repo will not recurse into it.
 *
 * Why hooks are disabled on the shadow repo:
 *   - The user's workspace may have pre-commit hooks (husky, pre-commit,
 *     lint-staged, etc.) set up for user-facing commits. Those have no
 *     business running on our internal snapshot commits — they would
 *     slow every turn down AND could outright fail on code Cline just
 *     wrote that hasn't been linted/formatted yet, breaking the feature.
 *   - We set `core.hooksPath=/dev/null` on the bare repo at init and also
 *     pass `--no-verify` on every commit, belt-and-suspenders.
 *   - `commit.gpgsign=false` on the bare repo so global GPG signing
 *     settings don't hang our commits on pinentry.
 *
 * Lifecycle:
 *   - createSnapshot(sid, label) before a user turn starts executing.
 *     Returns the SHA, which the caller records on the user-turn event.
 *   - restoreSnapshot(sid, sha) during a branch — reverts the workspace
 *     to that SHA's tree state (deletes files added after the snapshot,
 *     restores files changed / removed after).
 *   - deleteSnapshotsFor(sid) when the session is removed.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { WORKSPACE_DIR, CHAT_DATA_DIR } from '../core/paths.js';

const SNAPSHOTS_ROOT = path.join(CHAT_DATA_DIR, 'snapshots');

// Paths we force-exclude from snapshots even if the workspace `.gitignore`
// doesn't cover them. `.chat/` is already workspace-gitignored; belt-and-
// suspenders. `.git` is auto-handled by git itself.
const SHADOW_EXCLUDES = [
  '.chat/',
  '.DS_Store',
];

/** Return the shadow git dir for a session, creating the bare repo on first use. */
function ensureShadowRepo(sessionId) {
  const gitDir = path.join(SNAPSHOTS_ROOT, `${sessionId}.git`);
  if (!existsSync(gitDir)) {
    mkdirSync(SNAPSHOTS_ROOT, { recursive: true });
    execFileSync('git', ['init', '--bare', '--quiet', gitDir], { stdio: 'pipe' });

    // Disable hooks + gpg signing on this shadow repo. See module-level
    // comment for why. These are local-repo config lines; they don't touch
    // the user's global or workspace git config.
    execFileSync('git', ['--git-dir', gitDir, 'config', 'core.hooksPath', '/dev/null'], { stdio: 'pipe' });
    execFileSync('git', ['--git-dir', gitDir, 'config', 'commit.gpgsign', 'false'], { stdio: 'pipe' });

    // Write our extra excludes. The shadow repo honors BOTH this file and the
    // workspace's `.gitignore` (git walks from the work tree and applies any
    // `.gitignore` it encounters), so we only need to add paths not already
    // covered by the workspace's own rules.
    const excludePath = path.join(gitDir, 'info', 'exclude');
    const existing = existsSync(excludePath) ? readFileSync(excludePath, 'utf-8') : '';
    writeFileSync(excludePath, [existing.trimEnd(), ...SHADOW_EXCLUDES, ''].join('\n'));
  }
  return gitDir;
}

/** Build the git env for shadow-repo calls. Critical: GIT_DIR + GIT_WORK_TREE. */
function shadowEnv(gitDir) {
  return {
    ...process.env,
    GIT_DIR: gitDir,
    GIT_WORK_TREE: WORKSPACE_DIR,
    // Deterministic author identity — we never push these, it's local state.
    GIT_AUTHOR_NAME: 'chat-snapshot',
    GIT_AUTHOR_EMAIL: 'snapshot@chat.local',
    GIT_COMMITTER_NAME: 'chat-snapshot',
    GIT_COMMITTER_EMAIL: 'snapshot@chat.local',
  };
}

/** Run a git command against the shadow repo. Throws on non-zero exit. */
function gitShadow(gitDir, args) {
  const res = spawnSync('git', args, {
    env: shadowEnv(gitDir),
    cwd: WORKSPACE_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (res.status !== 0) {
    const err = (res.stderr || '').toString().trim() || (res.stdout || '').toString().trim();
    throw new Error(`git ${args.join(' ')} failed (exit ${res.status}): ${err}`);
  }
  return (res.stdout || '').toString();
}

/**
 * Capture the workspace state. Returns the commit SHA, or null on error.
 *
 * Uses `--allow-empty` so every call produces a SHA — even if nothing has
 * changed since the last snapshot. `--no-verify` skips hook execution;
 * paired with the `core.hooksPath=/dev/null` init config, this guarantees
 * user pre-commit hooks never fire on our internal snapshots.
 *
 * @param {string} sessionId
 * @param {string} [label] - Short commit message for debugging.
 * @returns {string|null} SHA or null on failure (we never throw so a
 *   snapshot failure can't take down a user turn).
 */
export function createSnapshot(sessionId, label = '') {
  try {
    const gitDir = ensureShadowRepo(sessionId);
    gitShadow(gitDir, ['add', '-A']);
    gitShadow(gitDir, [
      'commit', '--allow-empty', '--quiet', '--no-verify',
      '-m', label || `snapshot ${new Date().toISOString()}`,
    ]);
    const sha = gitShadow(gitDir, ['rev-parse', 'HEAD']).trim();
    return sha || null;
  } catch (err) {
    console.error('[snapshots] createSnapshot failed for session %s: %s', sessionId, err.message);
    return null;
  }
}

/**
 * Revert the workspace to a given snapshot SHA. DESTRUCTIVE — any changes
 * made to tracked files after this SHA are overwritten, and any files
 * added after this SHA are deleted.
 *
 * Handles the "in-flight turn" case: files created/modified DURING the
 * current turn (after its start-of-turn snapshot) are uncommitted in the
 * shadow repo, so a naive `diff target..HEAD` would miss them. We first
 * commit the current workspace state (unreachable throwaway commit) so
 * the diff captures those uncommitted changes, then proceed.
 *
 * The shadow repo's HEAD is moved to the target SHA so subsequent
 * snapshots branch off from the restored state (not from a dangling tip).
 *
 * @param {string} sessionId
 * @param {string} sha - Commit SHA previously returned by createSnapshot.
 * @returns {boolean} true on success.
 */
export function restoreSnapshot(sessionId, sha) {
  const gitDir = path.join(SNAPSHOTS_ROOT, `${sessionId}.git`);
  if (!existsSync(gitDir)) {
    console.error('[snapshots] restoreSnapshot: no shadow repo for session %s', sessionId);
    return false;
  }
  try {
    // 1. Commit the current workspace state into the shadow repo FIRST, so
    //    that files created mid-turn (after the start-of-turn snapshot that
    //    we're branching from) are captured in some commit. Without this,
    //    `diff <target> HEAD` would miss those files — HEAD is still at
    //    start-of-turn, and the new files are uncommitted — and they'd
    //    survive the restore despite not existing at the target.
    //
    //    The resulting commit is unreachable after we rewind HEAD in step 4;
    //    git will GC it eventually.
    gitShadow(gitDir, ['add', '-A']);
    gitShadow(gitDir, [
      'commit', '--allow-empty', '--quiet', '--no-verify',
      '-m', `pre-restore snapshot ${new Date().toISOString()}`,
    ]);

    // 2. Find files ADDED between <sha> and the (now up-to-date) HEAD.
    //    These files exist on disk but didn't exist at <sha>, so they must
    //    be removed before we check out <sha> — otherwise `git checkout <sha>
    //    -- .` leaves them untouched (checkout only overwrites paths that
    //    exist in the target tree).
    let addedSinceTarget = '';
    try {
      addedSinceTarget = gitShadow(gitDir, [
        'diff', '--name-only', '--diff-filter=A', sha, 'HEAD',
      ]);
    } catch {
      // Shouldn't happen after step 1 makes HEAD definitely different from
      // <sha> (unless nothing changed, in which case empty output).
    }
    for (const rel of addedSinceTarget.split('\n').map(s => s.trim()).filter(Boolean)) {
      const abs = path.join(WORKSPACE_DIR, rel);
      try { rmSync(abs, { force: true }); } catch { /* best-effort */ }
    }

    // 3. Restore tracked files to the <sha> state. `checkout <sha> -- .`
    //    overwrites modified files with their <sha> version and re-creates
    //    any that existed at <sha> but were deleted afterwards.
    gitShadow(gitDir, ['checkout', sha, '--', '.']);

    // 4. Move the shadow repo's HEAD to <sha> so future snapshots commit on
    //    top of the restored state rather than on top of the now-unreachable
    //    "pre-restore" tip.
    gitShadow(gitDir, ['update-ref', 'HEAD', sha]);

    return true;
  } catch (err) {
    console.error('[snapshots] restoreSnapshot failed for session %s sha %s: %s',
      sessionId, sha, err.message);
    return false;
  }
}

/** Delete all snapshots for a session (called on session removal). */
export function deleteSnapshotsFor(sessionId) {
  const gitDir = path.join(SNAPSHOTS_ROOT, `${sessionId}.git`);
  try { rmSync(gitDir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

/**
 * Return true iff a snapshot with the given SHA exists in the session's
 * shadow repo. Cheap — just asks git whether it has the object. Used by
 * the branch endpoint to validate the request before doing anything
 * destructive.
 */
export function snapshotExists(sessionId, sha) {
  const gitDir = path.join(SNAPSHOTS_ROOT, `${sessionId}.git`);
  if (!existsSync(gitDir)) return false;
  try {
    gitShadow(gitDir, ['cat-file', '-e', `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}
