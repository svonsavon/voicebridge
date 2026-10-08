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

# Keep an already-installed local Qwen runtime in sync with the repository
# without re-downloading model weights on every development rebuild.
QWEN_ROOT="$HOME/Library/Application Support/VoiceBridge/qwen-runtime"
if [[ -d "$QWEN_ROOT" && -f "runtime/qwen_server.py" ]]; then
  cp "runtime/qwen_server.py" "$QWEN_ROOT/qwen_server.py"
  echo "Synced local Qwen runtime server."
fi

# A locally built app does not require an Apple Developer signing identity.
export CSC_IDENTITY_AUTO_DISCOVERY=false
npx electron-builder --mac --arm64

echo
echo "Finished. Open the VoiceBridge.app inside dist/mac-arm64/."
