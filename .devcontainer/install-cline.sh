#!/usr/bin/env bash
# Install Cline VS Code extension manually to avoid Codespace marketplace download issues.
# The auto-install via devcontainer.json extensions can fail with large extensions (~50MB+)
# due to download timeouts or truncated zip files in Codespaces.

set -e

EXTENSION_ID="saoudrizwan.claude-dev"
VSIX_URL="https://saoudrizwan.gallery.vsassets.io/_apis/public/gallery/publisher/saoudrizwan/extension/claude-dev/latest/assetbyname/Microsoft.VisualStudio.Services.VSIXPackage"
VSIX_PATH="/tmp/cline.vsix"
MAX_RETRIES=3

echo "🤖 Installing Cline extension..."

for i in $(seq 1 $MAX_RETRIES); do
  echo "  Attempt $i/$MAX_RETRIES: Downloading VSIX..."
  if curl -fSL --retry 2 --retry-delay 3 -o "$VSIX_PATH" "$VSIX_URL"; then
    # Verify it's a valid zip
    if file "$VSIX_PATH" | grep -q "Zip archive"; then
      echo "  Download OK, installing..."
      code --install-extension "$VSIX_PATH" && {
        echo "✅ Cline installed successfully!"
        rm -f "$VSIX_PATH"
        exit 0
      }
    else
      echo "  Downloaded file is not a valid zip, retrying..."
      rm -f "$VSIX_PATH"
    fi
  else
    echo "  Download failed, retrying..."
    rm -f "$VSIX_PATH"
  fi
  sleep 5
done

echo "⚠️  Could not install Cline after $MAX_RETRIES attempts."
echo "   You can install it manually: Extensions sidebar → search 'Cline' → Install"
# Don't fail the entire Codespace setup over this
exit 0
