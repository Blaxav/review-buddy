#!/bin/sh
# Compiles the helper and registers it as a launchd agent that starts at login.
# Remove it with: launchctl bootout gui/$(id -u)/ai.review-ai.helper
set -eu
cd "$(dirname "$0")/.."

LABEL=ai.review-ai.helper
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
BIN="$HOME/.review-ai/bin/review-ai-helper"

bun run build:helper
mkdir -p "$(dirname "$BIN")" "$HOME/Library/LaunchAgents"
cp dist/review-ai-helper "$BIN"

# launchd starts agents with a bare PATH; the helper needs claude, gh and git.
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$BIN</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/.review-ai/helper.log</string>
  <key>StandardErrorPath</key><string>$HOME/.review-ai/helper.log</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Helper running. Logs: ~/.review-ai/helper.log"
