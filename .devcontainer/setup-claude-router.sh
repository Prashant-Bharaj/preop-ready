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

CCR_VERSION="2.0.0"
CCR_DIR="$HOME/.claude-code-router"
CLAUDE_DIR="$HOME/.claude"
CONFIG="$CCR_DIR/config.json"
MGA_BASE="https://chat.int.bayer.com/api/v2"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ─── 1. Install Claude Code CLI + claude-code-router (idempotent) ────
if command -v claude &>/dev/null; then
  echo "✅ Claude Code CLI already installed."
else
  echo "📦 Installing Claude Code CLI..."
  npm install -g @anthropic-ai/claude-code --silent 2>&1 | tail -3 \
    && echo "✅ Claude Code CLI installed." \
    || echo "⚠️  Claude Code CLI install failed. Run: npm install -g @anthropic-ai/claude-code"
fi

if command -v ccr &>/dev/null; then
  echo "✅ claude-code-router already installed ($(ccr version 2>/dev/null | head -1))."
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

# ─── 4. Resolve the myGenAssist key ─────────────────────────────────
if [ -n "${MYGENASSIST_API_KEY:-}" ]; then
  WRITE_CONFIG=1                       # key from secret / mga-login
elif [ -s "$CONFIG" ]; then
  WRITE_CONFIG=0                       # already configured (persisted)
  echo "ℹ️  Using previously-saved myGenAssist config."
else
  cat <<'BANNER'

  ┌────────────────────────────────────────────────────────────────┐
  │  Claude Code is installed but not yet connected to myGenAssist.  │
  │                                                                  │
  │  Run this once to paste your key and connect:                    │
  │                                                                  │
  │      mga-login                                                   │
  │                                                                  │
  │  (equivalently: bash .devcontainer/mga-login.sh)                 │
  └────────────────────────────────────────────────────────────────┘

BANNER
  exit 0
fi

# ─── 5. CCR config — the "Router" block + model_mapping are REQUIRED. ─
# Without them CCR cannot resolve the default model and every request
# crashes in ImageAgent.shouldHandle ("Cannot read properties of
# undefined (reading 'image')"). Do not remove them.
mkdir -p "$CCR_DIR/plugins"

if [ "$WRITE_CONFIG" = "1" ]; then
  cat > "$CONFIG" <<EOF
{
  "LOG": true,
  "LOG_LEVEL": "debug",
  "OPENAI_API_KEY": "${MYGENASSIST_API_KEY}",
  "OPENAI_BASE_URL": "${MGA_BASE}",
  "OPENAI_MODEL": "claude-opus-4.8-bedrock",
  "CUSTOM_ROUTER_PATH": "${CCR_DIR}/custom-router.js",
  "Providers": [
    {
      "name": "myGenAssist",
      "api_base_url": "${MGA_BASE}/chat/completions",
      "api_key": "${MYGENASSIST_API_KEY}",
      "models": [
        "claude-opus-4.8-bedrock",
        "claude-opus-4.8",
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
    "default": "myGenAssist,claude-opus-4.8-bedrock"
  }
}
EOF
  chmod 600 "$CONFIG"
  echo "✅ Wrote $CONFIG"
fi

# ─── 6. Model-mapping custom router (idempotent) ────────────────────
cat > "$CCR_DIR/custom-router.js" <<'EOF'
const MODEL_MAPPING = {
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
    return 'myGenAssist,claude-opus-4.8-bedrock';
  }
  if (requestedModel && requestedModel.toLowerCase().includes('sonnet')) {
    return 'myGenAssist,claude-sonnet-4.5-azure';
  }
  if (requestedModel && requestedModel.toLowerCase().includes('gemini')) {
    return `myGenAssist,${requestedModel}`;
  }
  return 'myGenAssist,claude-opus-4.8-bedrock';
};
EOF

# ─── 7. Point the Claude Code extension at the router ───────────────
# Written to $HOME (Codespace-scoped) — NOT the repo's .claude/settings.json,
# which would break maintainers' local Claude Code (no router on :3456).
# Merge so we don't clobber other user settings.
mkdir -p "$CLAUDE_DIR"
CLAUDE_DIR="$CLAUDE_DIR" node -e '
const fs = require("fs");
const f = process.env.CLAUDE_DIR + "/settings.json";
let c = {};
try { c = JSON.parse(fs.readFileSync(f)); } catch (e) {}
c.env = Object.assign({}, c.env, {
  ANTHROPIC_BASE_URL: "http://127.0.0.1:3456",
  ANTHROPIC_AUTH_TOKEN: "dummy",
  ANTHROPIC_MODEL: "myGenAssist,claude-opus-4.8-bedrock",
  ANTHROPIC_SMALL_FAST_MODEL: "myGenAssist,claude-sonnet-4.5-azure"
});
fs.writeFileSync(f, JSON.stringify(c, null, 2));
console.log("✅ Merged env into " + f);
' || echo "⚠️  Failed to update $CLAUDE_DIR/settings.json"

# ─── 8. Start the router daemon ─────────────────────────────────────
# TLS override scoped to the daemon (the Codespace reaches Bayer directly;
# this is belt-and-suspenders for internal-CA certs).
if command -v ccr &>/dev/null; then
  echo "🚀 Starting claude-code-router..."
  NODE_TLS_REJECT_UNAUTHORIZED=0 ccr restart >/dev/null 2>&1 \
    || NODE_TLS_REJECT_UNAUTHORIZED=0 ccr start >/dev/null 2>&1
  sleep 1
  if ccr status 2>/dev/null | grep -qi running; then
    echo "✅ Router running on http://127.0.0.1:3456 — Claude Code is ready."
    echo "   (If the Claude panel shows a model error, run 'Developer: Reload Window' once.)"
  else
    echo "⚠️  Router did not start. Start it manually: ccr start"
  fi
fi

exit 0