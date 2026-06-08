#!/usr/bin/env bash
# sync-to-s3.sh — Syncs the built portfolio-master folder to AWS S3.
#
# Called automatically after each successful portfolio build by the
# Electron app (Server mode). Can also be run manually:
#   bash scripts/sync-to-s3.sh
#
# SSO credentials expire every 8 hours (IT policy). This script handles
# that automatically — if they've expired, it opens your browser for a
# one-click approval and then continues the sync. No terminal needed.
#
# For fully seamless operation (credentials refreshed before they expire),
# install the LaunchAgent once with:
#   bash scripts/install-aws-autorefresh.sh

set -euo pipefail

# Ensure Homebrew and local binaries are in PATH (crucial when run from macOS GUI apps)
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

# ── Configuration ────────────────────────────────────────────────────────────
AWS_PROFILE="sso-profile"
S3_BUCKET="icfcreative-websitebucket-1iig2p33sr8sb"
S3_PREFIX="2026/BGE/portfolio-master"
BOX_FOLDER="${ICF_BOX_ROOT:-$HOME/Library/CloudStorage/Box-Box}"
LOCAL_DIR="$BOX_FOLDER/Clients/BGE/portfolio-master"
LOGIN_TIMEOUT=300  # seconds to wait for browser approval before giving up

# ── Helpers ──────────────────────────────────────────────────────────────────
log() { echo "[s3-sync] $*"; }

notify() {
  # Show a macOS notification (works in background, no terminal needed)
  osascript -e "display notification \"$1\" with title \"ICF Portfolio\" subtitle \"S3 Sync\"" 2>/dev/null || true
}

ensure_credentials() {
  if aws sts get-caller-identity --profile "$AWS_PROFILE" &>/dev/null; then
    return 0
  fi

  log "AWS credentials expired — opening browser for re-authentication..."
  notify "AWS login required — check your browser"

  # Run aws sso login with a timeout so we don't hang indefinitely
  # if the user isn't at their Mac (macOS-compatible, no `timeout` command needed)
  aws sso login --profile "$AWS_PROFILE" &
  LOGIN_PID=$!
  ( sleep "$LOGIN_TIMEOUT" && kill "$LOGIN_PID" 2>/dev/null ) &
  TIMER_PID=$!
  wait "$LOGIN_PID" 2>/dev/null && LOGIN_OK=true || LOGIN_OK=false
  kill "$TIMER_PID" 2>/dev/null; wait "$TIMER_PID" 2>/dev/null

  if ! $LOGIN_OK; then
    log "Login timed out or was cancelled. Sync skipped — will retry after next build."
    notify "Login timed out. Sync skipped."
    exit 0  # Exit cleanly — don't fail the build
  fi

  # Verify after login
  if ! aws sts get-caller-identity --profile "$AWS_PROFILE" &>/dev/null; then
    log "Authentication failed. Sync skipped."
    notify "Authentication failed. Check AWS access."
    exit 0
  fi

  log "Authentication successful — continuing sync."
  notify "AWS login successful — syncing..."
}

# ── Main ─────────────────────────────────────────────────────────────────────
if [ ! -d "$LOCAL_DIR" ]; then
  log "ERROR: portfolio-master not found at $LOCAL_DIR"
  exit 1
fi

ensure_credentials

S3_DEST="s3://$S3_BUCKET/$S3_PREFIX"
log "Syncing $LOCAL_DIR → $S3_DEST"

aws s3 sync "$LOCAL_DIR" "$S3_DEST" \
  --profile "$AWS_PROFILE" \
  --delete \
  --exclude ".DS_Store" \
  --exclude ".builder-active.json" \
  --exclude ".content-hash" \
  --exclude ".last-build-time" \
  --exclude ".markup-cache.json" \
  --exclude ".*" \
  --exclude "__pycache__/*" \
  --exclude "*.pyc" \
  --exclude "dev-index.html" \
  --no-progress

log "Sync complete — web version is now up to date."
notify "Sync complete — web version updated"
