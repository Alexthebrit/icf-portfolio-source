#!/usr/bin/env bash
# sync-to-s3.sh — Syncs the built portfolio-master folder to AWS S3.
#
# Called automatically after each successful portfolio build by the
# Electron app (Server mode). Can also be run manually:
#   bash scripts/sync-to-s3.sh
#
# Requirements:
#   - AWS CLI v2 installed (aws --version)
#   - SSO profile configured: aws sso login --profile sso-profile
#     (credentials are valid for 8 hours; the script will prompt to
#     re-login if they've expired)

set -euo pipefail

# ── Configuration ────────────────────────────────────────────────────────────
AWS_PROFILE="sso-profile"
S3_BUCKET="icfcreative-websitebucket-1iig2p33sr8sb"
S3_PREFIX="2026/BGE/portfolio-master"
BOX_FOLDER="${ICF_BOX_ROOT:-$HOME/Library/CloudStorage/Box-Box}"
LOCAL_DIR="$BOX_FOLDER/Clients/BGE/portfolio-master"

# ── Helpers ──────────────────────────────────────────────────────────────────
log() { echo "[s3-sync] $*"; }

# Check if SSO credentials are still valid; re-login if not.
ensure_credentials() {
  if aws sts get-caller-identity --profile "$AWS_PROFILE" &>/dev/null; then
    return 0
  fi

  log "SSO credentials expired — opening browser for re-authentication..."
  aws sso login --profile "$AWS_PROFILE"

  # Verify after login
  if ! aws sts get-caller-identity --profile "$AWS_PROFILE" &>/dev/null; then
    log "ERROR: Authentication failed. Cannot sync."
    exit 1
  fi
  log "Authentication successful."
}

# ── Main ─────────────────────────────────────────────────────────────────────
if [ ! -d "$LOCAL_DIR" ]; then
  log "ERROR: portfolio-master not found at $LOCAL_DIR"
  log "Is Box Drive mounted? Set ICF_BOX_ROOT env var if your Box folder is elsewhere."
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

log "Sync complete. Web version is now up to date."
