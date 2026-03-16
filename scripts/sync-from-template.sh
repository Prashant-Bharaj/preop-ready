#!/bin/bash
# =============================================================================
# Template Sync Script
# =============================================================================
# This script syncs platform files from the template repository to your project.
#
# Usage:
#   ./scripts/sync-from-template.sh [--dry-run] [--force]
#
# Options:
#   --dry-run    Show what would be changed without making changes
#   --force      Skip confirmation prompts
#
# What it does:
#   1. Adds the template repo as a git remote (if not already added)
#   2. Fetches the latest changes from the template
#   3. Cherry-picks only platform files (not your code)
#   4. Creates a commit with the updates
#
# =============================================================================

set -e

# Configuration
TEMPLATE_REPO="bayer-int/dd-template-repo"
TEMPLATE_REMOTE="template"
TEMPLATE_BRANCH="master"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Parse arguments
DRY_RUN=false
FORCE=false

for arg in "$@"; do
  case $arg in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --force)
      FORCE=true
      shift
      ;;
  esac
done

echo -e "${BLUE}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║         🔄 Template Sync Script                             ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""

# Check if we're in a git repo
if ! git rev-parse --is-inside-work-tree > /dev/null 2>&1; then
  echo -e "${RED}❌ Error: Not in a git repository${NC}"
  exit 1
fi

# Get current version
if [ -f .template-version ]; then
  CURRENT_VERSION=$(grep "^version:" .template-version | cut -d'"' -f2)
else
  CURRENT_VERSION="unknown"
fi

echo -e "${YELLOW}📦 Current version: ${NC}$CURRENT_VERSION"

# Add template remote if not exists
if ! git remote | grep -q "^${TEMPLATE_REMOTE}$"; then
  echo -e "${YELLOW}📡 Adding template remote...${NC}"
  if [ "$DRY_RUN" = false ]; then
    git remote add "$TEMPLATE_REMOTE" "https://github.com/${TEMPLATE_REPO}.git"
  fi
  echo -e "${GREEN}✅ Remote added: $TEMPLATE_REMOTE${NC}"
else
  echo -e "${GREEN}✅ Remote exists: $TEMPLATE_REMOTE${NC}"
fi

# Fetch from template
echo -e "${YELLOW}📥 Fetching from template repository...${NC}"
if [ "$DRY_RUN" = false ]; then
  git fetch "$TEMPLATE_REMOTE" "$TEMPLATE_BRANCH"
fi

# Get template version
TEMPLATE_VERSION=$(git show "${TEMPLATE_REMOTE}/${TEMPLATE_BRANCH}:.template-manifest.yml" 2>/dev/null | grep "^version:" | head -1 | cut -d'"' -f2)
echo -e "${YELLOW}📦 Template version: ${NC}$TEMPLATE_VERSION"

if [ "$CURRENT_VERSION" = "$TEMPLATE_VERSION" ]; then
  echo -e "${GREEN}✅ You're already on the latest version!${NC}"
  exit 0
fi

echo ""

# Read manifest from template to get file list
echo -e "${BLUE}📋 Reading manifest from template...${NC}"
MANIFEST=$(git show "${TEMPLATE_REMOTE}/${TEMPLATE_BRANCH}:.template-manifest.yml" 2>/dev/null)

if [ -z "$MANIFEST" ]; then
  echo -e "${RED}❌ Could not read manifest from template${NC}"
  exit 1
fi

# Parse auto_update entries for display
echo -e "${BLUE}📋 Files to sync (from manifest):${NC}"
echo "$MANIFEST" | awk '
/^auto_update:/ { in_section=1; next }
/^[a-zA-Z]/ && in_section { exit }
in_section && /^  - path:/ {
  gsub(/"/, "")
  printf "   - %s\n", $3
}
'
echo ""

echo -e "${BLUE}🔒 Files NOT touched (your code is safe):${NC}"
echo "$MANIFEST" | awk '
/^ignore:/ { in_section=1; next }
/^[a-zA-Z]/ && in_section { exit }
in_section && /^  - / {
  gsub(/"/, "")
  gsub(/^  - /, "")
  # Strip inline comments
  sub(/ *#.*$/, "")
  printf "   - %s\n", $0
}
'
echo ""

if [ "$DRY_RUN" = true ]; then
  echo -e "${YELLOW}🔍 DRY RUN MODE - No changes will be made${NC}"
  echo ""
fi

# Confirm unless --force
if [ "$FORCE" = false ] && [ "$DRY_RUN" = false ]; then
  echo -e "${YELLOW}Do you want to proceed with the sync? (y/N)${NC}"
  read -r response
  if [[ ! "$response" =~ ^[Yy]$ ]]; then
    echo -e "${RED}❌ Sync cancelled${NC}"
    exit 1
  fi
fi

if [ "$DRY_RUN" = true ]; then
  echo -e "${GREEN}✅ Dry run complete - no changes made${NC}"
  exit 0
fi

# Create backup branch
BACKUP_BRANCH="backup/pre-sync-$(date +%Y%m%d-%H%M%S)"
echo -e "${YELLOW}💾 Creating backup branch: $BACKUP_BRANCH${NC}"
git branch "$BACKUP_BRANCH"

# Remove deprecated files from manifest cleanup section
echo -e "${YELLOW}🧹 Removing deprecated files...${NC}"
echo "$MANIFEST" | awk '
/^cleanup:/ { in_section=1; next }
/^[a-zA-Z]/ && in_section { exit }
in_section && /^  - path:/ {
  gsub(/"/, "")
  path=$3
  next
}
in_section && /type:/ {
  gsub(/"/, "")
  type=$2
  if (path) print path, type
  path=""
  type=""
  next
}
END { if (path && type) print path, type }
' | while read -r path type; do
  case "$type" in
    directory)
      if [ -d "$path" ]; then
        rm -rf "$path"
        git rm -rf "$path" 2>/dev/null || true
        echo -e "${GREEN}  ✓ Removed $path/${NC}"
      fi
      ;;
    gitignore_entry)
      if [ -f .gitignore ] && grep -q "^${path}" .gitignore; then
        sed -i '' "/${path//\//\\/}/d" .gitignore
        echo -e "${GREEN}  ✓ Cleaned $path from .gitignore${NC}"
      fi
      ;;
  esac
done

# Sync files from manifest auto_update section
echo -e "${YELLOW}📁 Syncing files from manifest...${NC}"
echo "$MANIFEST" | awk '
/^auto_update:/ { in_section=1; next }
/^[a-zA-Z]/ && in_section { exit }
in_section && /^  - path:/ {
  if (path) print path, is_dir
  gsub(/"/, "")
  path=$3
  is_dir="false"
  next
}
in_section && /is_directory:/ {
  is_dir=$2
  next
}
END { if (path) print path, is_dir }
' | while read -r path is_dir; do
  dir=$(dirname "$path")
  [ "$dir" != "." ] && mkdir -p "$dir"

  if [ "$is_dir" = "true" ]; then
    rm -rf "$path"
    git checkout "${TEMPLATE_REMOTE}/${TEMPLATE_BRANCH}" -- "$path" 2>/dev/null && \
      echo -e "${GREEN}  ✓ $path (directory)${NC}" || \
      echo -e "${YELLOW}  ⏭️ $path (not found)${NC}"
  else
    git checkout "${TEMPLATE_REMOTE}/${TEMPLATE_BRANCH}" -- "$path" 2>/dev/null && \
      echo -e "${GREEN}  ✓ $path${NC}" || \
      echo -e "${YELLOW}  ⏭️ $path (not found)${NC}"
  fi
done

# Make scripts executable
chmod +x scripts/*.sh 2>/dev/null || true
chmod +x .devcontainer/*.sh 2>/dev/null || true

# Update version tracker
cat > .template-version << EOF
# Template Version Tracker
# This file tracks which template version this project is based on.
# AI uses this to check for and apply platform updates automatically.
#
# DO NOT DELETE THIS FILE - it helps keep your project up to date!

version: "$TEMPLATE_VERSION"
template_repo: "bayer-int/dd-template-repo"
created_at: ""
last_update_check: "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
EOF

# Check for changes
if [ -z "$(git status --porcelain)" ]; then
  echo -e "${GREEN}✅ No changes needed - you're up to date!${NC}"
  git branch -D "$BACKUP_BRANCH"
  exit 0
fi

# Show changes
echo ""
echo -e "${BLUE}📝 Changes to be committed:${NC}"
git status --short

# Commit changes
echo ""
echo -e "${YELLOW}💾 Committing changes...${NC}"
git add -A
git commit -m "chore: sync platform files from template v$TEMPLATE_VERSION

Updated from template version $CURRENT_VERSION → $TEMPLATE_VERSION

Files updated:
$(git diff --cached --name-only | sed 's/^/- /')

Backup branch: $BACKUP_BRANCH"

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║         ✅ Sync Complete!                                   ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "📦 Version: ${YELLOW}$CURRENT_VERSION${NC} → ${GREEN}$TEMPLATE_VERSION${NC}"
echo -e "💾 Backup branch: ${BLUE}$BACKUP_BRANCH${NC}"
echo ""
echo -e "${YELLOW}Next steps:${NC}"
echo "  1. Review the changes: git show HEAD"
echo "  2. Test locally: docker-compose up --build"
echo "  3. Push to deploy: git push"
echo ""
echo -e "${YELLOW}To undo:${NC}"
echo "  git reset --hard $BACKUP_BRANCH"
