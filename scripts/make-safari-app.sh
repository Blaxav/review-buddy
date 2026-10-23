#!/bin/sh
# Generates the Xcode project that wraps the extension into a macOS app, which
# Safari requires. Needs the full Xcode, not only the Command Line Tools.
# The project references extension/dist, so later `bun run build:extension`
# runs only need a rebuild in Xcode, not a new project.
set -eu
cd "$(dirname "$0")/.."

bun run build:extension
xcrun safari-web-extension-converter extension/dist \
  --project-location safari \
  --app-name "Review AI" \
  --bundle-identifier ai.review-ai.app \
  --macos-only \
  --no-open \
  --force
