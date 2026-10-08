#!/usr/bin/env bash
set -euo pipefail

ROOT="$HOME/Library/Application Support/VoiceBridge/qwen-runtime"
VENV="$ROOT/.venv"
SOURCE_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if [[ "$(uname -s)" != "Darwin" ]] || [[ "$(uname -m)" != "arm64" ]]; then
  echo "VoiceBridge Qwen runtime currently requires Apple Silicon macOS."
  exit 1
fi

mkdir -p "$ROOT"
cp "$SOURCE_DIR/runtime/qwen_server.py" "$ROOT/qwen_server.py"

PYTHON=""
for candidate in python3.12 python3.11 python3; do
  if command -v "$candidate" >/dev/null 2>&1; then
    PYTHON="$(command -v "$candidate")"
    break
  fi
done

if [[ -z "$PYTHON" ]]; then
  echo "Python 3.11+ is required. Install Python with Homebrew, then rerun this command."
  exit 1
fi

"$PYTHON" - <<'PY'
import sys
if sys.version_info < (3, 11):
    raise SystemExit("Python 3.11+ is required.")
print("Using Python", sys.version.split()[0])
PY

if [[ ! -x "$VENV/bin/python" ]]; then
  "$PYTHON" -m venv "$VENV"
fi

"$VENV/bin/python" -m pip install --upgrade pip wheel
"$VENV/bin/python" -m pip install --upgrade   "fastapi>=0.115"   "uvicorn>=0.34"   "numpy>=2.0"   "mlx-lm>=0.31.1"   "mlx-audio[tts]>=0.3.0"   "huggingface_hub[hf_xet]>=1.0"

echo
echo "Downloading local translation, preset TTS, and personal voice-clone models..."
"$VENV/bin/python" - <<'PY'
from huggingface_hub import snapshot_download

models = [
    "Qwen/Qwen3-0.6B-MLX-4bit",
    "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit",
    "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-8bit",
]
for model in models:
    print("Downloading", model)
    snapshot_download(model)
print("Qwen runtime is installed.")
PY

SPEAKER_DIR="$ROOT/models"
SPEAKER_MODEL="$SPEAKER_DIR/wespeaker_en_voxceleb_resnet34.onnx"
mkdir -p "$SPEAKER_DIR"
if [[ ! -f "$SPEAKER_MODEL" ]]; then
  echo
  echo "Downloading lightweight speaker-verification model..."
  curl -L --fail --retry 2 \
    "https://huggingface.co/csukuangfj/speaker-embedding-models/resolve/main/wespeaker_en_voxceleb_resnet34.onnx" \
    -o "$SPEAKER_MODEL.tmp"
  mv "$SPEAKER_MODEL.tmp" "$SPEAKER_MODEL"
fi

echo
echo "Installed at: $ROOT"
echo "VoiceBridge will start it automatically when multilingual features are used."
