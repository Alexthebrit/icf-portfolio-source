#!/usr/bin/env bash
#
# sync-source-to-box.sh — re-publish the canonical source folders to Box so
# whoever inherits this project after Alex can grab everything they need from
# a single Box location.
#
# Run this:
#   - After cutting a new release (so the snapshot matches the version)
#   - After any meaningful change to main.js / preload.js / index.html /
#     build-portfolio.py / serve-portfolio.py
#
# Usage:
#   bash scripts/sync-source-to-box.sh
#
# Box location: Box-Box/Clients/BGE/portfolio-master/Source/

set -euo pipefail

SRC_BOX="$HOME/Library/CloudStorage/Box-Box/Clients/BGE/portfolio-master/Source"
ELECTRON_SRC="$HOME/Desktop/ICF Portfolio App/v0.1.0"
PYTHON_SRC="$HOME/Desktop/ICF Portfolio App/ICF Portfolio Site"

if [ ! -d "$SRC_BOX" ]; then
  echo "Creating $SRC_BOX"
  mkdir -p "$SRC_BOX"
fi

echo "→ Syncing electron-app/ (excluding node_modules, dist)"
rsync -a --delete \
  --exclude 'node_modules' \
  --exclude 'dist' \
  --exclude '.DS_Store' \
  --exclude '._*' \
  "$ELECTRON_SRC/" "$SRC_BOX/electron-app/"

echo "→ Syncing python-engine/ (excluding archive, portfolio-master, caches)"
rsync -a --delete \
  --exclude 'archive' \
  --exclude 'portfolio-master' \
  --exclude '__pycache__' \
  --exclude '*.pyc' \
  --exclude '.DS_Store' \
  --exclude '*.pid' \
  --exclude '*.lock' \
  --exclude '*.zip' \
  "$PYTHON_SRC/" "$SRC_BOX/python-engine/"

echo "→ Refreshing BUILD_GUIDE.md at Source root"
cp "$ELECTRON_SRC/BUILD_GUIDE.md" "$SRC_BOX/BUILD_GUIDE.md"

echo ""
echo "✅ Source synced to:"
echo "   $SRC_BOX"
echo ""
echo "Size: $(du -sh "$SRC_BOX" | cut -f1)"
echo "Files: $(find "$SRC_BOX" -type f | wc -l | tr -d ' ')"
