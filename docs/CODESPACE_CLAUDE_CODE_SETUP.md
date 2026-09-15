# Claude Code in a Codespace (via myGenAssist)

This template wires **Claude Code** (the VS Code extension + CLI) to Bayer's
**myGenAssist** automatically when you open a Codespace. Claude Code talks to
myGenAssist's Anthropic-compatible gateway directly (`https://chat.int.bayer.com/anthropic`);
there is no local proxy to run.

It's automatic. Everything installs on Codespace create/start, and a shell hook prompts for your
key the first time you open a terminal.

## First time you open the Codespace

Open a terminal (Codespaces shows one on start) and it prompts:

```
Paste your myGenAssist API key (mga-...):
```

Paste your key (input is hidden) and press Enter. The key and the gateway settings are written
to `~/.claude/settings.json`, the key is checked against myGenAssist, and you're ready to code.
If the Claude panel still shows a model error, run **Developer: Reload Window** once.

`~/.claude/settings.json` lives in `$HOME` (outside the repo) and **persists across stop/start**.

## Every time after that

On subsequent opens the setup sees you're already configured and you can start coding out of the
box — no prompt.

## Re-entering / rotating the key

Run `mga-login` in any terminal to paste a fresh key (e.g. after a full rebuild wiped `$HOME`,
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
Claude Code (extension/CLI)  ──▶  https://chat.int.bayer.com/anthropic  (myGenAssist gateway)
        reads ~/.claude/settings.json → env: base URL, key, gateway flags, default models
```

`.devcontainer/setup-claude-code.sh` (runs on create and on every start, idempotent):
1. Installs the Claude Code CLI (pinned), and the Claude Code extension as a fallback if the
   marketplace install failed.
2. Registers `mga-login` and the first-terminal prompt.
3. Merges the gateway settings into `~/.claude/settings.json` (`env` block, file mode 600):
   `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` (your key), `CLAUDE_CODE_USE_GATEWAY=1`,
   `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`, the default models, and the telemetry
   opt-outs. Other settings in the file are left alone.
4. Checks the key with one request to the gateway's model list and reports the result.

Why the user-level file and not the devcontainer's `remoteEnv`: myGenAssist's Claude Code guide
requires the gateway variables at user level (a project-level `.claude/settings.json` is read too
late for provider detection), the file persists across stop/start, and the key never sits in a
tracked file.

Codespaces created before this change ran a local `claude-code-router` proxy. The setup migrates
the key out of its config; new Claude Code sessions use the gateway right away (the user-level
settings win over the old `remoteEnv` still injected into the container). The session that was
open during the update keeps talking to the router, which is left running for it. **Rebuild
Container** once when convenient: the first start after that drops the old env and removes the
router.

## Models

The default model is **`claude-sonnet-5`**. The gateway exposes every myGenAssist model through
the `/model` picker: Claude models under their normal ids (`claude-opus-4.6`, `claude-sonnet-5`, …)
and other providers with a `claude-mga-` prefix (`claude-mga-gpt-5.4-ptu`, `claude-mga-glm-5`).
The `env` block maps the Opus slot to `claude-opus-4.6`, the Haiku slot to `claude-mga-glm-5`
and adds `GPT-5.4 PTU (myGenAssist)` as an extra picker entry.

```
/model claude-opus-4.6        # most capable
/model claude-sonnet-5        # default
/model claude-mga-gpt-5.4-ptu # Azure GPT-5.4 via myGenAssist
```

## Troubleshooting

**"There's an issue with the selected model" / 401 or 403 from the gateway.**
This is an auth/entitlement rejection from myGenAssist — the plumbing works, the key
doesn't have access. Verify the key directly:
```bash
KEY=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.env.HOME+"/.claude/settings.json")).env.ANTHROPIC_AUTH_TOKEN)')
curl -s -o /dev/null -w "HTTP %{http_code}\n" -H "Authorization: Bearer $KEY" \
  -H "anthropic-version: 2023-06-01" https://chat.int.bayer.com/anthropic/v1/models
```
`200` → key is fine (reload the window). `401`/`403` → get a provisioned key and run `mga-login`;
no Codespace change fixes it.

**Non-Claude models rejected with 403.** `CLAUDE_CODE_USE_GATEWAY` is missing from the env
block (Claude Code then runs in first-party mode and only accepts native Anthropic ids). Re-run
`bash .devcontainer/setup-claude-code.sh`.

**Settings edits do nothing.** Claude Code reads `~/.claude/settings.json` at session start —
**Developer: Reload Window** (extension) or restart `claude` (terminal).

**A session opened before the gateway switch hangs.** It was started through the router; open a
new conversation (it uses the gateway) and run **Codespaces: Rebuild Container** once when
convenient.

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
**activates Claude Code** — installing it and writing the gateway settings. Paste your myGenAssist key when
the terminal prompts (or set it as a personal Codespaces secret so you're never asked).

### After that — automatic

Once the new scripts are in place you never repeat this:
- **Cline** checks for template updates at session start and applies them (activating Claude Code).
- **Opening/rebuilding a Codespace** runs the same update on start.

The old Cline VS Code extension isn't auto-uninstalled (harmless) — remove it from the Extensions
sidebar if you want.

## Notes

- The myGenAssist key lives only in `~/.claude/settings.json` (in `$HOME`, outside the repo,
  mode 600). Never commit a settings file containing it. If a key is ever exposed, rotate it in
  myGenAssist.

## Running the harness (chat UI) in a Codespace

The post-start hook installs `chat/` dependencies, builds the UI and **starts
the harness in the background** (log: `/tmp/harness.log`), so after opening or
restarting a Codespace the harness is already running. Start it by hand only if
it is not (`cd chat && npm start`). If you only use the editor (Claude Code,
Copilot, Cline), the running harness costs a single idle node process and
nothing else — it starts no containers until a build runs — and a notification
for port 5050 is all you see. To disable the auto-start entirely, set the
Codespaces secret `HARNESS_AUTOSTART` to `0`.

Port **5050** is pre-forwarded; open it from the Ports tab or the notification
(the built UI and the API share it). The generated app runs on port **8080**. `npm run dev` (Vite on 8889 with hot
reload) is only needed when editing the chat UI itself; if you use it, add the
port by hand in the Ports tab after Vite is listening — a forward created
earlier can leave the proxy's 404 page cached in your browser.

After a Codespace restart everything persists (workspace, `.harness/`, Docker
images and volumes). When the codespace idles out, the harness tab shows
"Your workspace went to sleep" with a **Wake it up** link: it opens the editor,
which starts the codespace, the start hook starts the harness, and the tab
reconnects by itself. If the app should be up afterwards, click **Start app**. The idle timeout can be raised to 4 hours in
GitHub Settings → Codespaces → Default idle timeout (applies to new codespaces).

### Ports and Codespace restarts

The harness (5050) and the generated app (8080, backend 3000) are pre-forwarded
in the devcontainer on purpose: GitHub registers a port on its proxy only when
it is listed there or when an editor auto-detects a listening process, and the
vibe portal starts codespaces through the API with no editor attached. A listed
port can go stale after an editor-driven restart (browser shows "page can't be
found" while the Ports tab and `gh codespace ports` still list it); the remedy
is right-click the port in the Ports tab, **Stop Forwarding Port**, then
**Add Port** again. `cd chat && npm start` is otherwise all it takes in a
codespace opened from the editor.

### Launched from the Vibe portal

The portal injects your myGenAssist key into the codespace as the secret
`MYGENASSIST_API_KEY`; the harness picks it up (platform endpoint, default
model), so there is no setup screen. Your own choices in the harness settings
(`.chat/secrets.json`) still take precedence. When the codespace also carries
`VIBE_PORTAL_URL`, the "workspace went to sleep" card sends you back to the
portal, whose **Start Vibe Coding** wakes the workspace and reopens the harness.

