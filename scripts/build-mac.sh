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

if [[ -x "$QWEN_ROOT/.venv/bin/python" ]]; then
  if ! "$QWEN_ROOT/.venv/bin/python" -c "import sherpa_onnx" >/dev/null 2>&1; then
    echo "Installing lightweight local speaker verifier..."
    "$QWEN_ROOT/.venv/bin/python" -m pip install "sherpa-onnx"
  fi

  SPEAKER_DIR="$QWEN_ROOT/models"
  SPEAKER_MODEL="$SPEAKER_DIR/wespeaker_en_voxceleb_resnet34.onnx"
  mkdir -p "$SPEAKER_DIR"
  if [[ ! -f "$SPEAKER_MODEL" ]]; then
    echo "Downloading 26.5 MB speaker-verification model..."
    if curl -L --fail --retry 2 \
      "https://huggingface.co/csukuangfj/speaker-embedding-models/resolve/main/wespeaker_en_voxceleb_resnet34.onnx" \
      -o "$SPEAKER_MODEL.tmp"; then
      mv "$SPEAKER_MODEL.tmp" "$SPEAKER_MODEL"
      echo "Installed speaker-verification model."
    else
      rm -f "$SPEAKER_MODEL.tmp"
      echo "Warning: speaker model download failed; Only my voice will fail open with a warning."
    fi
  fi
fi

WHISPER_MODELS="$HOME/Library/Application Support/VoiceBridge/runtime/models"
VAD_MODEL="$WHISPER_MODELS/ggml-silero-v6.2.0.bin"
if [[ -d "$WHISPER_MODELS" && ! -f "$VAD_MODEL" ]]; then
  echo "Downloading tiny Silero VAD model for speech-only triggering..."
  if curl -L --fail --retry 2     "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin"     -o "$VAD_MODEL.tmp"; then
    mv "$VAD_MODEL.tmp" "$VAD_MODEL"
    echo "Installed Silero VAD model."
  else
    rm -f "$VAD_MODEL.tmp"
    echo "Warning: Silero VAD download failed; VoiceBridge will use its front-end gate only."
  fi
fi

# A locally built app does not require an Apple Developer signing identity.
export CSC_IDENTITY_AUTO_DISCOVERY=false
npx electron-builder --mac --arm64

echo
echo "Finished. Open the VoiceBridge.app inside dist/mac-arm64/."
