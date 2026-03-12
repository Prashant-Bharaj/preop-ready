#!/usr/bin/env bash
# Install Cline VS Code extension manually to avoid Codespace marketplace download issues.
# The auto-install via devcontainer.json extensions can fail with large extensions (~50MB+)
# due to download timeouts or truncated zip files in Codespaces.

EXTENSION_ID="saoudrizwan.claude-dev"
VSIX_URL="https://saoudrizwan.gallery.vsassets.io/_apis/public/gallery/publisher/saoudrizwan/extension/claude-dev/latest/assetbyname/Microsoft.VisualStudio.Services.VSIXPackage"
VSIX_PATH="/tmp/cline.vsix"
EXTENSIONS_DIR="$HOME/.vscode-remote/extensions"

echo "🤖 Installing Cline extension..."

# Skip if already installed
if ls "$EXTENSIONS_DIR" 2>/dev/null | grep -qi "claude-dev"; then
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

# Extract VSIX (it's a zip) directly into the extensions directory
echo "  Extracting extension..."
EXTRACT_DIR="$EXTENSIONS_DIR/$EXTENSION_ID"
mkdir -p "$EXTRACT_DIR"
unzip -qo "$VSIX_PATH" "extension/*" -d /tmp/cline-extract
mv /tmp/cline-extract/extension/* "$EXTRACT_DIR/"
rm -rf /tmp/cline-extract "$VSIX_PATH"

echo "✅ Cline installed! Reload the window (Ctrl+Shift+P → 'Reload Window') to activate it."
exit 0
