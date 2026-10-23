#!/bin/sh
# Wraps the extension into the macOS app Safari requires, builds it signed to
# run locally, installs it in /Applications and opens it once so Safari
# registers the extension. Each build gets a new build number: Safari can
# ignore a rebuilt extension whose path and build number it has already seen.
# Needs the full Xcode, not only the Command Line Tools.
set -eu
cd "$(dirname "$0")/.."

bun run build:extension
xcrun safari-web-extension-converter extension/dist \
  --project-location safari \
  --app-name "Review AI" \
  --bundle-identifier ai.review-ai.Review-AI \
  --macos-only \
  --no-open \
  --force

xcodebuild -quiet \
  -project "safari/Review AI/Review AI.xcodeproj" \
  -scheme "Review AI" \
  -configuration Debug \
  -derivedDataPath safari/build \
  CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM= \
  CURRENT_PROJECT_VERSION="$(date +%s)" \
  build

APP="/Applications/Review AI.app"
pkill -f "$APP/Contents/MacOS/Review AI" || true
rm -rf "$APP"
cp -R "safari/build/Build/Products/Debug/Review AI.app" "$APP"
open "$APP"
