#!/bin/sh
# Compiles the helper and registers it as a launchd agent that starts at login.
# Remove it with: launchctl bootout gui/$(id -u)/ai.review-ai.helper
set -eu
cd "$(dirname "$0")/.."

LABEL=ai.review-ai.helper
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
BIN="$HOME/.review-ai/bin/review-ai-helper"
# launchd starts agents with a bare PATH; the helper needs claude, gh and git.
HELPER_PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

bun run build:helper
mkdir -p "$(dirname "$BIN")" "$HOME/Library/LaunchAgents"
cp dist/review-ai-helper "$BIN"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$BIN</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$HELPER_PATH</string>
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

# The helper checks PRs out with `gh pr checkout --worktree`, which gh 2.98 added.
gh_version=$(PATH="$HELPER_PATH" gh --version 2>/dev/null | awk 'NR == 1 { print $3 }')
if [ -z "$gh_version" ]; then
  echo "Warning: the GitHub CLI (gh) isn't installed. Install it with \`brew install gh\`, then run \`gh auth login\`." >&2
else
  major=${gh_version%%.*}
  minor=${gh_version#*.}
  minor=${minor%%.*}
  if [ "$major" -lt 2 ] || { [ "$major" -eq 2 ] && [ "$minor" -lt 98 ]; }; then
    echo "Warning: gh $gh_version is too old; Review AI needs gh 2.98 or newer. Update it with \`brew upgrade gh\`." >&2
  fi
fi
