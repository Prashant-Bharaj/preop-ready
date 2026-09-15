#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════╗
# ║  Configure Claude Code to use Bayer myGenAssist directly           ║
# ║  (native gateway mode — no local router).                         ║
# ║                                                                    ║
# ║  Boot (onCreate/postStart) installs the CLI and, IF a key is       ║
# ║  available, writes ~/.claude/settings.json. It never blocks on     ║
# ║  input (lifecycle hooks are non-interactive).                      ║
# ║                                                                    ║
# ║  The key is resolved from, in order:                              ║
# ║    1. MYGENASSIST_API_KEY  (Codespaces secret / mga-login)        ║
# ║    2. the token already in ~/.claude/settings.json                 ║
# ║       (from a previous run — persists across stop/start)          ║
# ║    3. an old ~/.claude-code-router/config.json (migrated once,     ║
# ║       then the router is removed)                                  ║
# ║  If none is present it prints how to run `mga-login`, which        ║
# ║  prompts for the key interactively and re-runs this script.        ║
# ║                                                                    ║
# ║  Idempotent — safe to re-run. Runs on onCreate + postStart.        ║
# ╚══════════════════════════════════════════════════════════════════╝
#
# Why ~/.claude/settings.json and not the devcontainer's remoteEnv: the
# gateway variables must be user-level (myGenAssist docs: a project-level
# .claude/settings.json is read too late for provider detection), the file
# persists across stop/start, and the key must not sit in a tracked file.

# Fail fast: this script writes an API key to disk. Silently continuing past a
# failed step leaves a half-wired Codespace that is harder to diagnose than a
# clean stop. Every step where failure is EXPECTED (optional tooling) handles
# its own status explicitly below.
set -euo pipefail

CLAUDE_CODE_VERSION="2.1.220"
CLAUDE_DIR="$HOME/.claude"
SETTINGS="$CLAUDE_DIR/settings.json"
GATEWAY_URL="https://chat.int.bayer.com/anthropic"
CCR_DIR="$HOME/.claude-code-router"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# cli_version <bin> — best-effort "x.y.z" from a CLI. Empty when not installed.
# `command -v` alone is not enough: a Codespace resumed from an old image has
# the binary but a stale version, and a plain presence check would never
# upgrade it — which is exactly how an unpinned install drifts.
cli_version() {
  command -v "$1" >/dev/null 2>&1 || return 0
  { "$1" --version 2>/dev/null || "$1" version 2>/dev/null || true; } \
    | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true
}

# settings_get <key> — read one string out of the settings env block ("" if absent).
settings_get() {
  [ -s "$SETTINGS" ] || return 0
  SETTINGS="$SETTINGS" node -e '
    try {
      const c = JSON.parse(require("fs").readFileSync(process.env.SETTINGS, "utf8"));
      const v = c && c.env && c.env[process.argv[1]];
      process.stdout.write(typeof v === "string" ? v : "");
    } catch { /* unreadable → "" */ }
  ' "$1" 2>/dev/null || true
}

# ─── 1. Install the Claude Code CLI (idempotent, PINNED) ────────────
# It sits in the path of the myGenAssist key and of every prompt, so the
# version that runs must be the version that was reviewed. The pinned build
# has native gateway support (CLAUDE_CODE_USE_GATEWAY + model discovery).
if [ "$(cli_version claude)" = "$CLAUDE_CODE_VERSION" ]; then
  echo "✅ Claude Code CLI ${CLAUDE_CODE_VERSION} already installed."
else
  echo "📦 Installing Claude Code CLI ${CLAUDE_CODE_VERSION}..."
  npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" --silent 2>&1 | tail -3 \
    && echo "✅ Claude Code CLI installed." \
    || echo "⚠️  Claude Code CLI install failed. Run: npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"
fi

# ─── 2. Claude Code VS Code extension — fallback install ────────────
# Primary install is the devcontainer.json extensions array. This is a
# best-effort fallback for when that fails (marketplace timeout in fresh
# Codespaces). Skips silently if the 'code' CLI isn't ready yet;
# postStart re-runs this script once it is.
if command -v code &>/dev/null; then
  if code --list-extensions 2>/dev/null | grep -qi "anthropic.claude-code"; then
    echo "✅ Claude Code extension already installed."
  else
    echo "🤖 Installing Claude Code extension (fallback)..."
    code --install-extension Anthropic.claude-code 2>&1 | tail -2 \
      || echo "⚠️  Extension install failed — add 'Claude Code' from the Extensions sidebar."
  fi
fi

# ─── 3. Register `mga-login` + auto-connect on first terminal ───────
# `.vscode/` is gitignored in this template, and VS Code won't let a repo
# pre-approve "automatic tasks" — so instead of a folderOpen task we prompt
# from shell startup (no security dialog). Both blocks are idempotent; a
# router-era auto-connect block (it watched the CCR config file) is replaced.
if ! grep -q 'alias mga-login=' "$HOME/.bashrc" 2>/dev/null; then
  echo "alias mga-login='bash \"$SCRIPT_DIR/mga-login.sh\"'" >> "$HOME/.bashrc"
fi
if grep -q 'mga-auto-connect' "$HOME/.bashrc" 2>/dev/null \
   && ! grep -q 'mga-auto-connect-v2' "$HOME/.bashrc" 2>/dev/null; then
  # Drop the old block: from its comment line to the first column-0 `fi`.
  awk '/# mga-auto-connect:/{skip=1} skip&&/^fi$/{skip=0; next} !skip' "$HOME/.bashrc" > "$HOME/.bashrc.tmp" \
    && mv "$HOME/.bashrc.tmp" "$HOME/.bashrc"
fi
if ! grep -q 'mga-auto-connect-v2' "$HOME/.bashrc" 2>/dev/null; then
  cat >> "$HOME/.bashrc" <<BASHRC

# mga-auto-connect-v2: on the first interactive terminal, prompt for the
# myGenAssist key until Claude Code is connected (a token in
# ~/.claude/settings.json). Deferred to the first ready prompt via
# PROMPT_COMMAND (not run inline at startup) so the terminal is fully
# interactive and the key input masks with '*', exactly like running
# mga-login by hand. Runs once, then restores PROMPT_COMMAND. (\$SCRIPT_DIR
# baked in at setup time.)
if [[ \$- == *i* ]] && [ -t 0 ] \\
   && ! grep -q '"ANTHROPIC_AUTH_TOKEN"' "\$HOME/.claude/settings.json" 2>/dev/null \\
   && [ -z "\${MYGENASSIST_API_KEY:-}" ] \\
   && [ -f "$SCRIPT_DIR/mga-login.sh" ]; then
  __mga_connect() {
    PROMPT_COMMAND="\$__mga_prev_pc"; unset __mga_prev_pc; unset -f __mga_connect
    grep -q '"ANTHROPIC_AUTH_TOKEN"' "\$HOME/.claude/settings.json" 2>/dev/null || bash "$SCRIPT_DIR/mga-login.sh"
  }
  __mga_prev_pc="\${PROMPT_COMMAND:-}"
  PROMPT_COMMAND="__mga_connect"
fi
BASHRC
fi

# ─── 4. Resolve the myGenAssist key ─────────────────────────────────
KEY="${MYGENASSIST_API_KEY:-}"
SOURCE="secret"
if [ -z "$KEY" ]; then
  KEY="$(settings_get ANTHROPIC_AUTH_TOKEN)"
  [ "$KEY" = "dummy" ] && KEY=""        # router-era placeholder, never a key
  [ -n "$KEY" ] && SOURCE="settings"
fi
if [ -z "$KEY" ] && [ -s "$CCR_DIR/config.json" ]; then
  # One-time migration from claude-code-router: its config held the key.
  KEY="$(CCR_CONFIG="$CCR_DIR/config.json" node -e '
    try { process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.env.CCR_CONFIG, "utf8")).OPENAI_API_KEY || "")); } catch {}
  ' 2>/dev/null || true)"
  [ -n "$KEY" ] && SOURCE="router-config"
fi

# ─── 5. Write ~/.claude/settings.json (merged, never clobbers other keys) ─
# The non-secret gateway settings are written even without a key, so the
# extension is pointed at the gateway from first launch; the token is added
# as soon as a key is known. Locked to 0600 BEFORE the key goes in.
mkdir -p "$CLAUDE_DIR"
[ -e "$SETTINGS" ] || : > "$SETTINGS"
chmod 600 "$SETTINGS"
SETTINGS="$SETTINGS" GATEWAY_URL="$GATEWAY_URL" MGA_KEY="$KEY" node -e '
const fs = require("fs");
const f = process.env.SETTINGS;
let c = {};
try { c = JSON.parse(fs.readFileSync(f, "utf8")) || {}; } catch (e) {}
const env = Object.assign({}, c.env);
// Router-era leftovers (the local proxy on :3456 and its model naming).
delete env.ANTHROPIC_SMALL_FAST_MODEL;
if (env.ANTHROPIC_AUTH_TOKEN === "dummy") delete env.ANTHROPIC_AUTH_TOKEN;
Object.assign(env, {
  ANTHROPIC_BASE_URL: process.env.GATEWAY_URL,
  CLAUDE_CODE_USE_GATEWAY: "1",
  CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
  // Default = Sonnet 5 (platform decision); Opus / Haiku slots and the extra
  // picker entry follow the myGenAssist Claude Code guide.
  ANTHROPIC_MODEL: "claude-sonnet-5",
  ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-5",
  ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4.6",
  ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-mga-glm-5",
  ANTHROPIC_CUSTOM_MODEL_OPTION: "claude-mga-gpt-5.4-ptu",
  ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: "GPT-5.4 PTU (myGenAssist)",
  ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION: "Azure GPT-5.4 Provisioned via myGenAssist",
  DISABLE_TELEMETRY: "1",
  CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1",
  DISABLE_ERROR_REPORTING: "1",
  DISABLE_AUTOUPDATER: "1",
});
if (process.env.MGA_KEY) env.ANTHROPIC_AUTH_TOKEN = process.env.MGA_KEY;
c.env = env;
fs.writeFileSync(f, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
console.log("✅ Wrote gateway settings to " + f + (process.env.MGA_KEY ? " (with key)" : " (no key yet)"));
' || echo "⚠️  Failed to update $SETTINGS"

# ─── 6. Retire claude-code-router if this Codespace still has it ────
# The key is in settings.json now; the router config (which held it in
# cleartext) and the daemon have no job left.
if [ -d "$CCR_DIR" ] || command -v ccr &>/dev/null; then
  if command -v ccr &>/dev/null; then
    ccr stop >/dev/null 2>&1 || true
    npm uninstall -g @musistudio/claude-code-router --silent >/dev/null 2>&1 || true
  fi
  rm -rf "$CCR_DIR"
  echo "🧹 Removed claude-code-router (Claude Code now talks to myGenAssist directly)."
fi

if [ -z "$KEY" ]; then
  cat <<'BANNER'

  ┌──────────────────────────────────────────────────────────────────┐
  │  Claude Code is installed but not yet connected to myGenAssist.  │
  │                                                                  │
  │  ➜  OPEN A NEW TERMINAL — it will ask for your key by itself.    │
  │                                                                  │
  │  (or connect right here, in this terminal:                       │
  │       bash .devcontainer/mga-login.sh )                          │
  └──────────────────────────────────────────────────────────────────┘

BANNER
  exit 0
fi

# ─── 7. Soft key check (never blocks) ───────────────────────────────
# A bearer GET on the gateway's model list answers 200 for a valid key and
# 401 for a rejected one; anything else (VPN, proxy, outage) is inconclusive.
CODE="$(curl -s -m 8 -o /dev/null -w '%{http_code}' \
  -H "Authorization: Bearer $KEY" -H 'anthropic-version: 2023-06-01' \
  "$GATEWAY_URL/v1/models" 2>/dev/null || echo 000)"
case "$CODE" in
  200) echo "✅ myGenAssist key verified (source: $SOURCE) — Claude Code is ready." ;;
  401|403) echo "⚠️  myGenAssist rejected the key (HTTP $CODE). Run 'mga-login' with a valid key." ;;
  *) echo "ℹ️  Key saved (source: $SOURCE); could not reach myGenAssist to verify (HTTP $CODE)." ;;
esac
if [ "${ANTHROPIC_BASE_URL:-}" = "http://127.0.0.1:3456" ]; then
  echo "ℹ️  This Codespace still carries the old router env (remoteEnv). Rebuild the container once"
  echo "   (Codespaces: Rebuild Container) so Claude Code reads the gateway settings cleanly."
fi
echo "   (If the Claude panel shows a model error, run 'Developer: Reload Window' once.)"

exit 0
