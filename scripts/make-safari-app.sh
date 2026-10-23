#!/bin/sh
# Wraps the extension into the macOS app Safari requires, builds it signed to
# run locally, and opens it once so Safari registers the extension.
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
  build
open "safari/build/Build/Products/Debug/Review AI.app"
