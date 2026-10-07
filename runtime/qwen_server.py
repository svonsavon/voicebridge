#!/usr/bin/env python3
import argparse
import io
import re
import threading
import wave

import numpy as np
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

TRANSLATION_MODEL = "Qwen/Qwen3-0.6B-MLX-4bit"
TTS_MODEL = "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit"

VOICES = [
    {"id": "Ryan", "name": "Ryan", "nativeLanguage": "English"},
    {"id": "Aiden", "name": "Aiden", "nativeLanguage": "English"},
    {"id": "Vivian", "name": "Vivian", "nativeLanguage": "Chinese"},
    {"id": "Serena", "name": "Serena", "nativeLanguage": "Chinese"},
    {"id": "Uncle_Fu", "name": "Uncle Fu", "nativeLanguage": "Chinese"},
    {"id": "Dylan", "name": "Dylan", "nativeLanguage": "Chinese"},
    {"id": "Eric", "name": "Eric", "nativeLanguage": "Chinese"},
    {"id": "Ono_Anna", "name": "Ono Anna", "nativeLanguage": "Japanese"},
    {"id": "Sohee", "name": "Sohee", "nativeLanguage": "Korean"},
]

app = FastAPI(title="VoiceBridge Qwen Runtime")

_translation_model = None
_translation_tokenizer = None
_tts_model = None
_translation_lock = threading.Lock()
_tts_lock = threading.Lock()


class TranslateRequest(BaseModel):
    text: str
    source: str = "Auto"
    target: str


class TTSRequest(BaseModel):
    text: str
    language: str = "Auto"
    voice: str = "Ryan"


def load_translation():
    global _translation_model, _translation_tokenizer
    if _translation_model is None:
        from mlx_lm import load
        _translation_model, _translation_tokenizer = load(TRANSLATION_MODEL)
    return _translation_model, _translation_tokenizer


def load_tts():
    global _tts_model
    if _tts_model is None:
        from mlx_audio.tts.utils import load_model
        _tts_model = load_model(TTS_MODEL)
    return _tts_model


def strip_thinking(text: str) -> str:
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.S | re.I)
    return text.strip().strip('"').strip()


def wav_bytes(audio, sample_rate: int) -> bytes:
    samples = np.asarray(audio, dtype=np.float32).reshape(-1)
    if samples.size == 0:
        raise ValueError("TTS returned empty audio")
    samples = np.clip(samples, -1.0, 1.0)
    pcm = (samples * 32767.0).astype("<i2").tobytes()

    out = io.BytesIO()
    with wave.open(out, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(int(sample_rate))
        handle.writeframes(pcm)
    return out.getvalue()


@app.get("/health")
def health():
    return {
        "ok": True,
        "translationLoaded": _translation_model is not None,
        "ttsLoaded": _tts_model is not None,
    }


@app.get("/voices")
def voices():
    return {"voices": VOICES}


@app.post("/translate")
def translate(req: TranslateRequest):
    text = req.text.strip()
    if not text:
        return {"text": ""}

    source = req.source.strip() or "Auto"
    target = req.target.strip()
    if not target:
        raise HTTPException(status_code=400, detail="target language is required")

    with _translation_lock:
        model, tokenizer = load_translation()
        messages = [
            {
                "role": "system",
                "content": (
                    "You are a real-time speech translator. Translate conversational speech faithfully and naturally. "
                    "Preserve names, meaning, tone, questions, slang, and level of politeness. "
                    "Do not explain, annotate, romanize, or add quotation marks. Output only the translated speech."
                ),
            },
            {
                "role": "user",
                "content": f"Source language: {source}\nTarget language: {target}\nSpeech: {text}\n/no_think",
            },
        ]

        try:
            prompt = tokenizer.apply_chat_template(
                messages,
                tokenize=False,
                add_generation_prompt=True,
                enable_thinking=False,
            )
        except TypeError:
            prompt = tokenizer.apply_chat_template(
                messages,
                tokenize=False,
                add_generation_prompt=True,
            )

        from mlx_lm import generate
        result = generate(
            model,
            tokenizer,
            prompt=prompt,
            max_tokens=256,
            verbose=False,
        )
        translated = strip_thinking(str(result))

    if not translated:
        raise HTTPException(status_code=500, detail="translation model returned empty text")
    return {"text": translated}


@app.post("/tts")
def tts(req: TTSRequest):
    text = req.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="text is required")

    voice_ids = {voice["id"] for voice in VOICES}
    if req.voice not in voice_ids:
        raise HTTPException(status_code=400, detail=f"unknown voice: {req.voice}")

    with _tts_lock:
        model = load_tts()
        results = list(
            model.generate_custom_voice(
                text=text,
                speaker=req.voice,
                language=req.language or "Auto",
            )
        )
        if not results:
            raise HTTPException(status_code=500, detail="TTS returned no audio")
        result = results[0]
        sample_rate = int(getattr(model, "sample_rate", 24000))
        data = wav_bytes(result.audio, sample_rate)

    return Response(content=data, media_type="audio/wav")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8321)
    args = parser.parse_args()
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
