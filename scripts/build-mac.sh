#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Build this .app on the Mac itself."
  exit 1
fi
if ! command -v node >/dev/null || ! command -v npm >/dev/null; then
  echo "Node.js/npm are required."
  exit 1
fi

npm install
bash scripts/build-hotkey.sh

# A locally built app does not require an Apple Developer signing identity.
export CSC_IDENTITY_AUTO_DISCOVERY=false
npx electron-builder --mac --arm64

echo
echo "Finished. Open the VoiceBridge.app inside dist/mac-arm64/."
