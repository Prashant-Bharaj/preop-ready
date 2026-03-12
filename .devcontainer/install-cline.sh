#!/usr/bin/env bash
# Install Cline VS Code extension manually to avoid Codespace marketplace download issues.
# The auto-install via devcontainer.json extensions can fail with large extensions (~50MB+)
# due to download timeouts or truncated zip files in Codespaces.

VSIX_URL="https://saoudrizwan.gallery.vsassets.io/_apis/public/gallery/publisher/saoudrizwan/extension/claude-dev/latest/assetbyname/Microsoft.VisualStudio.Services.VSIXPackage"
VSIX_PATH="/tmp/cline.vsix"

echo "🤖 Installing Cline extension..."

# Find the VS Code server binary (available in Codespaces even when 'code' CLI is not)
CODE_SERVER=$(find /vscode/bin -name "code-server" -type f 2>/dev/null | head -1)
if [ -z "$CODE_SERVER" ]; then
  CODE_SERVER=$(find /usr/lib/code-server -name "code-server" -type f 2>/dev/null | head -1)
fi
if [ -z "$CODE_SERVER" ]; then
  # Fallback: wait for 'code' to become available (postAttachCommand timing)
  for i in $(seq 1 10); do
    if command -v code &>/dev/null; then
      CODE_SERVER="code"
      break
    fi
    echo "  Waiting for VS Code CLI... ($i/10)"
    sleep 3
  done
fi

if [ -z "$CODE_SERVER" ]; then
  echo "⚠️  VS Code CLI not found. Install Cline manually from the Extensions sidebar."
  exit 0
fi

echo "  Using: $CODE_SERVER"

# Skip if already installed
if "$CODE_SERVER" --list-extensions 2>/dev/null | grep -qi "claude-dev"; then
  echo "✅ Cline is already installed, skipping."
  exit 0
fi

# Download the VSIX
echo "  Downloading VSIX..."
if ! curl -fSL --retry 3 --retry-delay 5 -o "$VSIX_PATH" "$VSIX_URL"; then
  echo "⚠️  Download failed. Install Cline manually from the Extensions sidebar."
  exit 0
fi

# Verify it's a valid zip
if ! file "$VSIX_PATH" | grep -q "Zip archive"; then
  echo "⚠️  Downloaded file is not a valid zip. Install Cline manually from the Extensions sidebar."
  rm -f "$VSIX_PATH"
  exit 0
fi

# Install
echo "  Installing extension..."
if "$CODE_SERVER" --install-extension "$VSIX_PATH" 2>&1; then
  echo "✅ Cline installed successfully!"
else
  echo "⚠️  Install command failed. Install Cline manually from the Extensions sidebar."
fi

rm -f "$VSIX_PATH"
exit 0
