#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════╗
# ║  Configure Claude Code to use Bayer myGenAssist via                ║
# ║  claude-code-router (CCR).                                         ║
# ║                                                                    ║
# ║  Boot (onCreate/postStart) installs the tools and, IF a key is     ║
# ║  available, wires everything up and starts the router. It never    ║
# ║  blocks on input (lifecycle hooks are non-interactive).            ║
# ║                                                                    ║
# ║  The key is resolved from, in order:                              ║
# ║    1. MYGENASSIST_API_KEY  (optional Codespaces secret)           ║
# ║    2. an existing ~/.claude-code-router/config.json (from a        ║
# ║       previous `mga-login` — persists across stop/start)          ║
# ║  If neither is present it prints how to run `mga-login`, which     ║
# ║  prompts for the key interactively and re-runs this script.        ║
# ║                                                                    ║
# ║  Idempotent — safe to re-run. Runs on onCreate + postStart.        ║
# ╚══════════════════════════════════════════════════════════════════╝

# Fail fast: this script writes an API key to disk and starts a daemon that
# talks to Bayer. Silently continuing past a failed step leaves a half-wired
# Codespace that is harder to diagnose than a clean stop. Every step where
# failure is EXPECTED (optional tooling, a daemon that may already be dead)
# handles its own status explicitly below.
set -euo pipefail

CCR_VERSION="2.0.0"
CLAUDE_CODE_VERSION="2.1.220"
CCR_DIR="$HOME/.claude-code-router"
CLAUDE_DIR="$HOME/.claude"
CONFIG="$CCR_DIR/config.json"
MGA_BASE="https://chat.int.bayer.com/api/v2"
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

# ─── 1. Install Claude Code CLI + claude-code-router (idempotent) ────
# Both are PINNED: they sit in the path of the myGenAssist key and of every
# prompt, so the version that runs must be the version that was reviewed.
if [ "$(cli_version claude)" = "$CLAUDE_CODE_VERSION" ]; then
  echo "✅ Claude Code CLI ${CLAUDE_CODE_VERSION} already installed."
else
  echo "📦 Installing Claude Code CLI ${CLAUDE_CODE_VERSION}..."
  npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" --silent 2>&1 | tail -3 \
    && echo "✅ Claude Code CLI installed." \
    || echo "⚠️  Claude Code CLI install failed. Run: npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"
fi

if [ "$(cli_version ccr)" = "$CCR_VERSION" ]; then
  echo "✅ claude-code-router ${CCR_VERSION} already installed."
else
  echo "📦 Installing claude-code-router@${CCR_VERSION}..."
  npm install -g "@musistudio/claude-code-router@${CCR_VERSION}" --silent 2>&1 | tail -3 \
    && echo "✅ claude-code-router installed." \
    || echo "⚠️  CCR install failed. Run: npm install -g @musistudio/claude-code-router@${CCR_VERSION}"
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
# from shell startup (no security dialog). Both blocks are idempotent.
if ! grep -q 'alias mga-login=' "$HOME/.bashrc" 2>/dev/null; then
  echo "alias mga-login='bash \"$SCRIPT_DIR/mga-login.sh\"'" >> "$HOME/.bashrc"
fi
if ! grep -q 'mga-auto-connect' "$HOME/.bashrc" 2>/dev/null; then
  cat >> "$HOME/.bashrc" <<BASHRC

# mga-auto-connect: on the first interactive terminal, prompt for the
# myGenAssist key until Claude Code is connected. Deferred to the first ready
# prompt via PROMPT_COMMAND (not run inline at startup) so the terminal is
# fully interactive and the key input masks with '*', exactly like running
# mga-login by hand. Runs once, then restores PROMPT_COMMAND. Self-clears once
# the config exists. (\$SCRIPT_DIR baked in at setup time.)
if [[ \$- == *i* ]] && [ -t 0 ] \\
   && [ ! -s "\$HOME/.claude-code-router/config.json" ] \\
   && [ -z "\${MYGENASSIST_API_KEY:-}" ] \\
   && [ -f "$SCRIPT_DIR/mga-login.sh" ]; then
  __mga_connect() {
    PROMPT_COMMAND="\$__mga_prev_pc"; unset __mga_prev_pc; unset -f __mga_connect
    [ -s "\$HOME/.claude-code-router/config.json" ] || bash "$SCRIPT_DIR/mga-login.sh"
  }
  __mga_prev_pc="\${PROMPT_COMMAND:-}"
  PROMPT_COMMAND="__mga_connect"
fi
BASHRC
fi

# ─── 3b. Point the Claude Code extension at the router ──────────────
# Runs BEFORE the key check so the extension always knows the router URL —
# even with no key yet. Otherwise a migrated Codespace (which lacks remoteEnv
# until a rebuild) shows Claude Code's login screen instead of the chat.
# Written to $HOME (Codespace-scoped), merged so we don't clobber other settings.
mkdir -p "$CLAUDE_DIR"
CLAUDE_DIR="$CLAUDE_DIR" node -e '
const fs = require("fs");
const f = process.env.CLAUDE_DIR + "/settings.json";
let c = {};
try { c = JSON.parse(fs.readFileSync(f)); } catch (e) {}
c.env = Object.assign({}, c.env, {
  ANTHROPIC_BASE_URL: "http://127.0.0.1:3456",
  ANTHROPIC_AUTH_TOKEN: "dummy",
  ANTHROPIC_MODEL: "myGenAssist,claude-sonnet-5",
  ANTHROPIC_SMALL_FAST_MODEL: "myGenAssist,claude-sonnet-4.5-azure"
});
fs.writeFileSync(f, JSON.stringify(c, null, 2));
console.log("✅ Merged env into " + f);
' || echo "⚠️  Failed to update $CLAUDE_DIR/settings.json"

# ─── 4. Resolve the myGenAssist key ─────────────────────────────────
if [ -n "${MYGENASSIST_API_KEY:-}" ]; then
  WRITE_CONFIG=1                       # key from secret / mga-login
elif [ -s "$CONFIG" ]; then
  WRITE_CONFIG=0                       # already configured (persisted)
  echo "ℹ️  Using previously-saved myGenAssist config."
else
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

# ─── 5. CCR config — the "Router" block + model_mapping are REQUIRED. ─
# Without them CCR cannot resolve the default model and every request
# crashes in ImageAgent.shouldHandle ("Cannot read properties of
# undefined (reading 'image')"). Do not remove them.
#
# LOG_LEVEL stays at "info". At "debug" CCR writes full request and response
# bodies to disk — i.e. every prompt, every file the assistant reads and every
# code fragment it writes, in cleartext, in a file that outlives the session.
# Only raise it temporarily while debugging the router itself.
mkdir -p "$CCR_DIR/plugins"

if [ "$WRITE_CONFIG" = "1" ]; then
  # Lock the file down BEFORE the key goes into it. `cat > "$CONFIG"` creates
  # it at the ambient umask (0022 → world-readable) and the chmod only landed
  # afterwards — a window in which any other user or process on the machine
  # could read the raw myGenAssist key. Truncating an existing file with `>`
  # keeps its mode, so 600 holds for the write below.
  : > "$CONFIG"
  chmod 600 "$CONFIG"

  cat > "$CONFIG" <<EOF
{
  "LOG": true,
  "LOG_LEVEL": "info",
  "OPENAI_API_KEY": "${MYGENASSIST_API_KEY}",
  "OPENAI_BASE_URL": "${MGA_BASE}",
  "OPENAI_MODEL": "claude-sonnet-5",
  "CUSTOM_ROUTER_PATH": "${CCR_DIR}/custom-router.js",
  "Providers": [
    {
      "name": "myGenAssist",
      "api_base_url": "${MGA_BASE}/chat/completions",
      "api_key": "${MYGENASSIST_API_KEY}",
      "models": [
        "claude-sonnet-5",
        "claude-opus-4.5-azure",
        "claude-sonnet-4.5-azure",
        "gemini-2.5-pro",
        "claude-sonnet-4-5",
        "claude-sonnet-4-5-20250929",
        "claude-opus-4-5",
        "claude-opus-4-5-20250929"
      ],
      "model_mapping": {
        "claude-sonnet-4-5": "claude-sonnet-4.5-azure",
        "claude-sonnet-4-5-20250929": "claude-sonnet-4.5-azure",
        "claude-opus-4-5": "claude-opus-4.5-azure",
        "claude-opus-4-5-20250929": "claude-opus-4.5-azure"
      }
    }
  ],
  "Router": {
    "default": "myGenAssist,claude-sonnet-5"
  }
}
EOF
  echo "✅ Wrote $CONFIG"
fi

# ─── 6. Model-mapping custom router (idempotent) ────────────────────
cat > "$CCR_DIR/custom-router.js" <<'EOF'
const MODEL_MAPPING = {
  'claude-sonnet-5': 'claude-sonnet-5',
  'claude-sonnet-4-5': 'claude-sonnet-4.5-azure',
  'claude-sonnet-4-5-20250929': 'claude-sonnet-4.5-azure',
  'claude-opus-4-5': 'claude-opus-4.5-azure',
  'claude-opus-4-5-20250929': 'claude-opus-4.5-azure',
  'claude-sonnet-4': 'claude-sonnet-4.5-azure',
  'claude-opus-4': 'claude-opus-4.5-azure',
};

module.exports = async function router(req, config) {
  const requestedModel = req.body?.model;
  console.log(`[custom-router] Requested model: ${requestedModel}`);

  if (requestedModel && MODEL_MAPPING[requestedModel]) {
    return `myGenAssist,${MODEL_MAPPING[requestedModel]}`;
  }
  if (requestedModel && requestedModel.toLowerCase().includes('opus')) {
    return 'myGenAssist,claude-opus-4.5-azure';
  }
  if (requestedModel && requestedModel.toLowerCase().includes('sonnet')) {
    return 'myGenAssist,claude-sonnet-4.5-azure';
  }
  if (requestedModel && requestedModel.toLowerCase().includes('gemini')) {
    return `myGenAssist,${requestedModel}`;
  }
  return 'myGenAssist,claude-sonnet-5';
};
EOF

# ─── 8. Start the router daemon ─────────────────────────────────────
# TLS trust for the daemon. CCR carries the myGenAssist API key and every
# prompt/code fragment to chat.int.bayer.com, so its TLS verification must
# stay ON. Bayer terminates TLS with an internal CA, so Node is pointed at the
# system trust store (which the Codespace image already has the CA in) via
# NODE_EXTRA_CA_CERTS — it ADDS roots, it does not replace them.
#
# ⛔ Never NODE_TLS_REJECT_UNAUTHORIZED=0 here: that disables verification
#    outright, so anything on the path can present its own certificate and
#    read the key and the code being sent.
CA_BUNDLE=""
for _ca in \
  "${NODE_EXTRA_CA_CERTS:-}" \
  /etc/ssl/certs/ca-certificates.crt \
  /etc/pki/tls/certs/ca-bundle.crt \
  /etc/ssl/cert.pem
do
  if [ -n "$_ca" ] && [ -r "$_ca" ]; then CA_BUNDLE="$_ca"; break; fi
done
unset _ca

if command -v ccr &>/dev/null; then
  if [ -n "$CA_BUNDLE" ]; then
    export NODE_EXTRA_CA_CERTS="$CA_BUNDLE"
  else
    # No system bundle: fall back to Node's built-in roots, still verifying.
    unset NODE_EXTRA_CA_CERTS
    echo "⚠️  No system CA bundle found — starting with Node's built-in roots."
    echo "   If the router reports a certificate error, point it at your CA:"
    echo "     export NODE_EXTRA_CA_CERTS=/path/to/bayer-ca.pem"
    echo "     bash .devcontainer/setup-claude-router.sh"
  fi
  echo "🚀 Starting claude-code-router..."
  # Expected to fail on a first run (nothing to restart) — the status check
  # below is what decides, so neither call may abort the script.
  ccr restart >/dev/null 2>&1 || ccr start >/dev/null 2>&1 || true
  sleep 1
  if ccr status 2>/dev/null | grep -qi running; then
    echo "✅ Router running on http://127.0.0.1:3456 — Claude Code is ready."
    echo "   (If the Claude panel shows a model error, run 'Developer: Reload Window' once.)"
  else
    echo "⚠️  Router did not start. Start it manually: ccr start"
  fi
fi

exit 0