#!/usr/bin/env bash
# aws-sso-refresh.sh — Pre-emptively refresh AWS SSO credentials.
#
# Called by the macOS LaunchAgent at login and every 6 hours thereafter.
# Only opens the browser if credentials are expiring within 90 minutes,
# so most runs are completely silent.
#
# Install with:
#   bash scripts/install-aws-autorefresh.sh

set -euo pipefail

AWS_PROFILE="sso-profile"
REFRESH_WITHIN=$((90 * 60))  # 90 minutes in seconds

log() { echo "[sso-refresh] $*"; }

is_session_fresh() {
  local expiry_epoch now remaining

  # Quick check — if STS works, we have valid credentials
  if ! aws sts get-caller-identity --profile "$AWS_PROFILE" &>/dev/null; then
    return 1  # Expired or missing
  fi

  # Find the SSO cache entry with the most recent expiry
  expiry_epoch=0
  if [ -d "$HOME/.aws/sso/cache" ]; then
    for f in "$HOME/.aws/sso/cache"/*.json; do
      [ -f "$f" ] || continue
      local parsed
      parsed=$(python3 -c "
import json, sys, re
try:
    d = json.load(open('$f'))
    v = d.get('expiresAt', '')
    # Strip sub-second precision and timezone suffix
    v = re.sub(r'\.[0-9]+', '', v)
    v = v.replace('Z', '').replace('+00:00', '')
    print(v)
except Exception:
    print('')
" 2>/dev/null)
      [ -n "$parsed" ] || continue
      local e
      e=$(date -j -f "%Y-%m-%dT%H:%M:%S" "$parsed" +%s 2>/dev/null || echo 0)
      [ "$e" -gt "$expiry_epoch" ] && expiry_epoch=$e
    done
  fi

  [ "$expiry_epoch" -eq 0 ] && return 0  # No cache file — assume fresh (STS passed)

  now=$(date +%s)
  remaining=$((expiry_epoch - now))
  [ "$remaining" -gt "$REFRESH_WITHIN" ]
}

if is_session_fresh; then
  log "Credentials still fresh — no action needed."
  exit 0
fi

log "Credentials expiring soon or expired — refreshing..."
aws sso login --profile "$AWS_PROFILE"
log "Refresh complete."
