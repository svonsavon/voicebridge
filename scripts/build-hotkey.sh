#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p build
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Hotkey helper can only be compiled on macOS."
  exit 1
fi
xcrun swiftc native/HotkeyHelper.swift -O -framework ApplicationServices -o build/hotkey-helper
chmod +x build/hotkey-helper
echo "Built build/hotkey-helper"
