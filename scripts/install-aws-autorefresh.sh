#!/usr/bin/env bash
# install-aws-autorefresh.sh — Install the LaunchAgent for automatic SSO refresh.
#
# What this does:
#   1. Copies the LaunchAgent plist to ~/Library/LaunchAgents/
#   2. Unloads any existing instance (so the new one takes effect)
#   3. Loads the new LaunchAgent
#
# After install, the agent runs:
#   - Immediately at your next login
#   - Every 6 hours thereafter (well within the 8-hour SSO expiry)
#
# The refresh script is smart — it checks actual token expiry and only opens
# your browser when credentials are within 90 minutes of expiring. Most runs
# are completely silent.
#
# To verify it's loaded:
#   launchctl list com.icf.aws-sso-refresh
#
# To remove (unload):
#   launchctl unload ~/Library/LaunchAgents/com.icf.aws-sso-refresh.plist
#   rm ~/Library/LaunchAgents/com.icf.aws-sso-refresh.plist

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLIST_SRC="$SCRIPT_DIR/com.icf.aws-sso-refresh.plist"
PLIST_DEST="$HOME/Library/LaunchAgents/com.icf.aws-sso-refresh.plist"
REFRESH_SCRIPT="$SCRIPT_DIR/aws-sso-refresh.sh"
LOCAL_BIN="$HOME/.local/bin"
REFRESH_DEST="$LOCAL_BIN/aws-sso-refresh.sh"

# ── Validate ─────────────────────────────────────────────────────────────────
if [ ! -f "$PLIST_SRC" ]; then
  echo "ERROR: $PLIST_SRC not found — are you running from the project root?"
  exit 1
fi

if [ ! -f "$REFRESH_SCRIPT" ]; then
  echo "ERROR: $REFRESH_SCRIPT not found"
  exit 1
fi

# Copy script to a location launchd can access (Desktop is restricted)
mkdir -p "$LOCAL_BIN"
cp "$REFRESH_SCRIPT" "$REFRESH_DEST"
chmod +x "$REFRESH_DEST"

# Ensure LaunchAgents directory exists
mkdir -p "$HOME/Library/LaunchAgents"

# Unload existing instance if running (ignore failure)
launchctl unload "$PLIST_DEST" 2>/dev/null || true

# Copy plist
cp "$PLIST_SRC" "$PLIST_DEST"

# Load the agent
launchctl load "$PLIST_DEST"

echo ""
echo "  Installed: $PLIST_DEST"
echo "  Runs at login and every 6 hours thereafter."
echo ""
echo "  Logs:  /tmp/com.icf.aws-sso-refresh.log"
echo "  Errors: /tmp/com.icf.aws-sso-refresh.err"
echo ""

# Verify it's loaded
if launchctl list com.icf.aws-sso-refresh &>/dev/null; then
  echo "  Status: loaded and running"
else
  echo "  Status: loaded (will run at next login)"
fi

echo ""
echo "To trigger an immediate test run:"
echo "  bash \"$REFRESH_SCRIPT\""
echo ""
