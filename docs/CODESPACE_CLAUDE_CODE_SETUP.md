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

Set a Codespaces **user secret** named **`MYGENASSIST_API_KEY`** and the Codespace wires up
with no prompt at all. Two steps, both on github.com → your **Settings → Codespaces**:

1. **Create the secret** (`MYGENASSIST_API_KEY` = your `mga-...` key) — once, ever.
2. **Grant it repository access**: open the secret → *Repository access* → add your repo →
   **Save changes**. Repeat this step for each new repo you create from the template.

⚠️ The **"Associate with repository?" checkbox on the codespace-create screen does NOT work
reliably** — it can silently fail to save the association (the Codespace then starts without
the key and prompts for it). Always grant access via the settings page instead. If a running
Codespace is missing the key, fix the access there, then **stop and restart** the Codespace —
secrets are injected on start, no rebuild needed.

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

An existing repo still has the *old* update scripts, which can't fetch the new files on their own
(the Codespace API token is restricted in this org). So there's a **one-time** migration — done
through **Cline** (no workflow, no admin, no rebuild needed). After that, updates are automatic.

### One-time: ask Cline to migrate

Open the **Cline** chat, paste this message, and approve the commands when prompted:

> Update this project to the latest platform template and set up Claude Code. Run:
>
> ```
> git remote remove template 2>/dev/null; git remote add template https://github.com/bayer-int/dd-template-repository.git
> git fetch template master
> git show template/master:scripts/apply-updates.sh > scripts/apply-updates.sh
> chmod +x scripts/apply-updates.sh
> bash scripts/apply-updates.sh
> ```

Cline fetches the new (git-based) `apply-updates.sh` and runs it. That single script syncs every
platform file **via git** (which works where the API is blocked), removes `install-cline.sh`, and
**activates Claude Code** — installing it and starting the router. Paste your myGenAssist key when
the terminal prompts (or set it as a personal Codespaces secret so you're never asked).

### After that — automatic

Once the new scripts are in place you never repeat this:
- **Cline** checks for template updates at session start and applies them (activating Claude Code).
- **Opening/rebuilding a Codespace** runs the same update on start.

The old Cline VS Code extension isn't auto-uninstalled (harmless) — remove it from the Extensions
sidebar if you want.

## Notes

- The myGenAssist key lives only in `~/.claude-code-router/config.json` (in `$HOME`, outside the
  repo). Never commit it. If a key is ever exposed, rotate it in myGenAssist.

## Running the harness (chat UI) in a Codespace

The post-start hook installs `chat/` dependencies, builds the UI and **starts
the harness in the background** (log: `/tmp/harness.log`), so after opening or
restarting a Codespace the harness is already running. Start it by hand only if
it is not (`cd chat && npm start`). If you only use the editor (Claude Code,
Copilot, Cline), the running harness costs a single idle node process and
nothing else — it starts no containers until a build runs — and a notification
for port 5050 is all you see. To disable the auto-start entirely, set the
Codespaces secret `HARNESS_AUTOSTART` to `0`.

Port **5050** is forwarded automatically once the server listens; open it from
the notification or the Ports tab (the built UI and the API share it). The generated app runs on port **8080**. `npm run dev` (Vite on 8889 with hot
reload) is only needed when editing the chat UI itself; if you use it, add the
port by hand in the Ports tab after Vite is listening — a forward created
earlier can leave the proxy's 404 page cached in your browser.

After a Codespace restart everything persists (workspace, `.harness/`, Docker
images and volumes). When the codespace idles out, the harness tab shows
"Your workspace went to sleep" with a **Wake it up** link: it opens the editor,
which starts the codespace, the start hook starts the harness, and the tab
reconnects by itself. If the app should be up afterwards, click **Start app**. The idle timeout can be raised to 4 hours in
GitHub Settings → Codespaces → Default idle timeout (applies to new codespaces).

### Ports after a Codespace restart

Ports are not pre-forwarded on purpose. A forward created by the devcontainer at
startup goes stale on GitHub's proxy after a restart: the browser shows "page
can't be found" while the Ports tab, `gh codespace ports` and `localhost` all look
fine. Codespaces auto-forwards a port the moment a process listens on it, and
that forward is fresh every time — so `cd chat && npm start` is all it takes;
5050 opens in the browser by itself. If a port URL ever 404s, right-click it in
the Ports tab, **Stop Forwarding Port**, then **Add Port** again.

### Launched from the Vibe portal

The portal injects your myGenAssist key into the codespace as the secret
`MYGENASSIST_API_KEY`; the harness picks it up (platform endpoint, default
model), so there is no setup screen. Your own choices in the harness settings
(`.chat/secrets.json`) still take precedence. When the codespace also carries
`VIBE_PORTAL_URL`, the "workspace went to sleep" card sends you back to the
portal, whose **Start Vibe Coding** wakes the workspace and reopens the harness.

