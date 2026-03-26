#!/usr/bin/env bash
# FALLBACK installer for Cline VS Code extension.
# Primary install: devcontainer.json extensions array (saoudrizwan.claude-dev).
# This script runs as postAttachCommand and only acts if the extensions array
# failed (e.g., marketplace timeout on large ~50MB+ VSIX in Codespaces).
# If Cline is already installed, this script exits immediately.

VSIX_URL="https://saoudrizwan.gallery.vsassets.io/_apis/public/gallery/publisher/saoudrizwan/extension/claude-dev/latest/assetbyname/Microsoft.VisualStudio.Services.VSIXPackage"
VSIX_PATH="/tmp/cline.vsix"

echo "🤖 Installing Cline extension..."

# Wait for the 'code' CLI to become available (it's set up after VS Code fully attaches)
for i in $(seq 1 20); do
  if command -v code &>/dev/null; then
    break
  fi
  echo "  Waiting for VS Code CLI... ($i/20)"
  sleep 3
done

if ! command -v code &>/dev/null; then
  echo "⚠️  VS Code CLI not available. Install Cline manually from the Extensions sidebar."
  exit 0
fi

# Skip if already installed
if code --list-extensions 2>/dev/null | grep -qi "claude-dev"; then
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

# Install via the VS Code CLI (routes through IPC to the live instance)
echo "  Installing extension..."
if code --install-extension "$VSIX_PATH" 2>&1; then
  echo "✅ Cline installed successfully!"
else
  echo "⚠️  Install failed. Install Cline manually from the Extensions sidebar."
fi

rm -f "$VSIX_PATH"
exit 0
