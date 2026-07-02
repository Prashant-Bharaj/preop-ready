# Claude Code in a Codespace (via myGenAssist)

This template wires **Claude Code** (the VS Code extension + CLI) to Bayer's
**myGenAssist** API automatically when you open a Codespace. It uses
[`claude-code-router`](https://github.com/musistudio/claude-code-router) (CCR) as a
translation proxy (Anthropic ↔ myGenAssist's OpenAI-compatible format).

It's automatic. Everything installs on Codespace create/start, and a shell hook prompts for your
key the first time you open a terminal.

## First time you open the Codespace

Open a terminal (Codespaces shows one on start) and it prompts:

```
Paste your myGenAssist API key (mga-...):
```

Paste your key (input is hidden) and press Enter. The config is written, the router starts, and
you're ready to code — the extension is already pointed at the router (via the devcontainer's
`remoteEnv`), so no reload is normally needed. If the panel still shows a model error, run
**Developer: Reload Window** once.

The key is saved in `~/.claude-code-router/config.json` and **persists across stop/start**.

## Every time after that

On subsequent opens the task sees you're already configured, **starts the router automatically**,
and you can start coding out of the box — no prompt.

## Re-entering / rotating the key

Run `mga-login` in any terminal to paste a fresh key (e.g. after a full rebuild wiped the config,
or a key rotation).

## Optional: zero-touch via a secret

For central/org provisioning, set a Codespaces secret named **`MYGENASSIST_API_KEY`**
(org or account → Settings → Secrets and variables → Codespaces). If present, the Codespace
wires up with no prompt at all.

> Why a shell hook and not a devcontainer task? Lifecycle hooks (`onCreate`/`postStart`) run
> without a terminal, so they can't prompt. A `folderOpen` VS Code task *can*, but VS Code makes
> the user click "allow automatic tasks" first (a repo can't pre-approve it). A guarded snippet in
> `~/.bashrc` prompts on the first interactive terminal with no dialog, and self-clears once the
> key is saved.

## How it works

```
Claude Code (extension/CLI)  ──▶  CCR daemon (127.0.0.1:3456)  ──▶  myGenAssist
                                  custom-router.js maps model names    chat.int.bayer.com
```

The setup script:
1. Installs the Claude Code CLI + `claude-code-router` (pinned), and the Claude Code
   extension as a fallback if the marketplace install failed.
2. Writes `~/.claude-code-router/config.json` and `custom-router.js` from the secret.
3. Merges `~/.claude/settings.json` so the extension points at the router.
4. Starts the CCR daemon (`ccr start`).

After a fresh start you may need **Developer: Reload Window** once so the extension
picks up the router env.

## Router commands

| Command | Description |
|---|---|
| `ccr status` | Is the router running? |
| `ccr start` / `ccr stop` | Start / stop the daemon |
| `ccr restart` | Restart (after any config change) |
| `ccr code` | Launch Claude Code in the terminal through the router |

## Switching models

In the Claude panel or terminal:

```
/model myGenAssist,claude-opus-4.5-azure    # most capable
/model myGenAssist,claude-sonnet-4.5-azure  # faster
/model myGenAssist,gemini-2.5-pro           # Gemini
```

## Troubleshooting

**"There's an issue with the selected model" / 403 `No associated account found`.**
This is an auth/entitlement rejection from myGenAssist — the plumbing works, the key
doesn't have access. Verify the key directly (bypassing CCR):
```bash
curl -s -w "\nHTTP %{http_code}\n" -X POST https://chat.int.bayer.com/api/v2/chat/completions \
  -H "Authorization: Bearer $MYGENASSIST_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"claude-opus-4.5-azure","messages":[{"role":"user","content":"hi"}]}'
```
`200` → key is fine (re-check config). `403` → get a provisioned key; no Codespace change fixes it.

**`500` → `Cannot read properties of undefined (reading 'image')` (`ImageAgent.shouldHandle`).**
The `"Router"` block is missing from `config.json`. The setup script always writes it; if you
hand-edited the config, restore the `"Router": { "default": "myGenAssist,claude-opus-4.5-azure" }`
block and `ccr restart`.

**Config edits do nothing.** The daemon caches config at start — always `ccr restart` after editing.

**Nothing reaches the router.** Reload the window (extension env is read at session start), and
confirm `ccr status` shows it running on `:3456`.

**View the log:**
```bash
LOG=$(find ~/.claude-code-router -name '*.log' -printf '%T@ %p\n' | sort -rn | head -1 | awk '{print $2}'); tail -n 40 "$LOG"
```

## Existing repos: migrating from Cline

Repos created before this change get it automatically through the template auto-update:

1. Open (or restart) your Codespace. The auto-update syncs the new files and removes the old
   Cline installer (`install-cline.sh`).
2. On the **next** start, Claude Code + the router are set up for you — the update runs
   `setup-claude-router.sh` automatically (no rebuild required). Open a terminal and paste your
   key when prompted.
3. For the cleanest result (extension env applied with no reload), rebuild the container once:
   **Cmd/Ctrl+Shift+P → "Codespaces: Rebuild Container"**.

The old Cline VS Code extension isn't auto-uninstalled (it's harmless) — remove it from the
Extensions sidebar if you want.

## Notes

- The myGenAssist key lives only in `~/.claude-code-router/config.json` (in `$HOME`, outside the
  repo). Never commit it. If a key is ever exposed, rotate it in myGenAssist.
