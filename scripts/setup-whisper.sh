#!/bin/bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This runtime installer is intended for macOS."
  exit 1
fi

ROOT="$HOME/Library/Application Support/VoiceBridge/runtime"
BIN="$ROOT/bin"
MODELS="$ROOT/models"
SRC="$ROOT/src/whisper.cpp"
mkdir -p "$BIN" "$MODELS" "$(dirname "$SRC")"

if ! command -v git >/dev/null; then
  echo "git is required. Install Apple's Command Line Tools first: xcode-select --install"
  exit 1
fi
if ! command -v cmake >/dev/null; then
  if command -v brew >/dev/null; then
    brew install cmake
  else
    echo "cmake is required. Install Homebrew or cmake, then rerun."
    exit 1
  fi
fi

if [[ ! -d "$SRC/.git" ]]; then
  git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git "$SRC"
else
  git -C "$SRC" pull --ff-only
fi

cmake -S "$SRC" -B "$SRC/build" -DGGML_METAL=ON -DCMAKE_BUILD_TYPE=Release
cmake --build "$SRC/build" --config Release --parallel --target whisper-server
cp "$SRC/build/bin/whisper-server" "$BIN/whisper-server"
chmod +x "$BIN/whisper-server"

if [[ ! -f "$MODELS/ggml-small.bin" ]]; then
  bash "$SRC/models/download-ggml-model.sh" small "$MODELS"
fi

VAD_MODEL="$MODELS/ggml-silero-v6.2.0.bin"
if [[ ! -f "$VAD_MODEL" ]]; then
  echo "Downloading Silero VAD model..."
  curl -L --fail --retry 2     "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin"     -o "$VAD_MODEL.tmp"
  mv "$VAD_MODEL.tmp" "$VAD_MODEL"
fi

echo
echo "Whisper installed entirely locally at:"
echo "  $ROOT"
echo "Model: $MODELS/ggml-small.bin"
echo "VAD:   $MODELS/ggml-silero-v6.2.0.bin"
