#!/usr/bin/env python3
import argparse
import gc
import io
import re
import threading
import wave

import numpy as np
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel

TRANSLATION_MODEL = "Qwen/Qwen3-0.6B-MLX-4bit"
TTS_MODEL = "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit"
CLONE_MODEL = "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-8bit"

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
_clone_model = None
_translation_lock = threading.Lock()
_tts_lock = threading.Lock()
_clone_lock = threading.Lock()


class TranslateRequest(BaseModel):
    text: str
    source: str = "Auto"
    target: str


class TTSRequest(BaseModel):
    text: str
    language: str = "Auto"
    voice: str = "Ryan"


class CloneTTSRequest(BaseModel):
    text: str
    language: str = "Auto"
    ref_audio: str
    ref_text: str


class PrepareCloneRequest(BaseModel):
    ref_audio: str
    ref_text: str


def release_mlx_cache():
    gc.collect()
    try:
        import mlx.core as mx
        mx.clear_cache()
    except Exception:
        pass


def load_translation():
    global _translation_model, _translation_tokenizer
    if _translation_model is None:
        from mlx_lm import load
        _translation_model, _translation_tokenizer = load(TRANSLATION_MODEL)
    return _translation_model, _translation_tokenizer


def load_tts():
    global _tts_model, _clone_model
    # The two Qwen TTS checkpoints are each large. Keep only the active one
    # resident so switching from presets to My Voice does not double memory use.
    if _tts_model is None:
        if _clone_model is not None:
            _clone_model = None
            release_mlx_cache()
        from mlx_audio.tts.utils import load_model
        _tts_model = load_model(TTS_MODEL)
    return _tts_model


def load_clone_tts():
    global _clone_model, _tts_model
    if _clone_model is None:
        if _tts_model is not None:
            _tts_model = None
            release_mlx_cache()
        from mlx_audio.tts.utils import load_model
        _clone_model = load_model(CLONE_MODEL)
    return _clone_model


def strip_thinking(text: str) -> str:
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.S | re.I)
    return text.strip().strip('"').strip()


def generation_limits(text: str):
    # VoiceBridge utterances are short conversational turns. Qwen3-TTS runs at
    # roughly 12.5 codec tokens/sec; this cap leaves generous headroom while
    # preventing the known no-EOS runaway from generating minutes of garbage.
    chars = max(1, len(text.strip()))
    max_tokens = min(320, max(80, chars * 5))
    max_duration = min(30.0, max(6.0, chars * 0.35 + 5.0))
    return max_tokens, max_duration


def validate_generated_audio(audio, sample_rate: int, text: str, token_count: int = 0, max_tokens: int = 0):
    samples = np.asarray(audio, dtype=np.float32).reshape(-1)
    if samples.size == 0:
        raise HTTPException(status_code=422, detail="UNSAFE_AUDIO: TTS returned empty audio")
    if not np.all(np.isfinite(samples)):
        raise HTTPException(status_code=422, detail="UNSAFE_AUDIO: TTS returned NaN/Inf samples")

    duration = samples.size / float(sample_rate)
    _, max_duration = generation_limits(text)
    if duration > max_duration:
        raise HTTPException(
            status_code=422,
            detail=f"RUNAWAY_AUDIO: generated {duration:.1f}s for a short utterance (limit {max_duration:.1f}s)"
        )

    if max_tokens and token_count >= max_tokens - 1:
        raise HTTPException(
            status_code=422,
            detail=f"RUNAWAY_AUDIO: generation hit token cap ({token_count}/{max_tokens})"
        )

    abs_samples = np.abs(samples)
    peak = float(abs_samples.max())
    rms = float(np.sqrt(np.mean(samples * samples)))
    clip_ratio = float(np.mean(abs_samples >= 0.999))

    if peak > 1.25 or rms > 0.45 or clip_ratio > 0.01:
        raise HTTPException(
            status_code=422,
            detail=(
                "UNSAFE_AUDIO: abnormal output level "
                f"(peak={peak:.3f}, rms={rms:.3f}, clipped={clip_ratio:.2%})"
            )
        )

    return samples


def wav_bytes(audio, sample_rate: int, text: str = "", token_count: int = 0, max_tokens: int = 0) -> bytes:
    samples = validate_generated_audio(audio, sample_rate, text, token_count, max_tokens)
    samples = np.clip(samples, -1.0, 1.0)
    pcm = (samples * 32767.0).astype("<i2").tobytes()
    out = io.BytesIO()
    with wave.open(out, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(int(sample_rate))
        handle.writeframes(pcm)
    return out.getvalue()


def stream_pcm16(audio, sample_rate: int, text: str) -> bytes:
    # Per-chunk safety. Total duration is enforced by the stream endpoint.
    samples = validate_generated_audio(audio, sample_rate, text, 0, 0)
    samples = np.clip(samples, -1.0, 1.0)
    return (samples * 32767.0).astype("<i2").tobytes()

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
        "cloneLoaded": _clone_model is not None,
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

    max_tokens, _ = generation_limits(text)
    with _tts_lock:
        model = load_tts()
        results = list(
            model.generate_custom_voice(
                text=text,
                speaker=req.voice,
                language=req.language or "Auto",
                max_tokens=max_tokens,
            )
        )
        if not results:
            raise HTTPException(status_code=500, detail="TTS returned no audio")
        result = results[0]
        sample_rate = int(getattr(result, "sample_rate", getattr(model, "sample_rate", 24000)))
        token_count = int(getattr(result, "token_count", 0) or 0)
        data = wav_bytes(result.audio, sample_rate, text, token_count, max_tokens)

    return Response(content=data, media_type="audio/wav")



@app.post("/prepare-clone")
def prepare_clone(req: PrepareCloneRequest):
    if not req.ref_audio:
        raise HTTPException(status_code=400, detail="reference audio path is required")
    if not req.ref_text.strip():
        raise HTTPException(status_code=400, detail="reference transcript is required")

    with _clone_lock:
        model = load_clone_tts()

        # Prime MLX-Audio's built-in ICL reference cache without synthesizing
        # a full phrase. This moves reference encoding off the first live turn.
        try:
            from mlx_audio.utils import load_audio
            ref_audio = load_audio(req.ref_audio, sample_rate=model.sample_rate)
            model._prepare_icl_generation_inputs(
                text=".",
                ref_audio=ref_audio,
                ref_text=req.ref_text.strip(),
                language="auto",
            )
        except Exception:
            # Model warm-up still succeeded even if a future MLX-Audio version
            # changes the private cache-prep helper.
            pass

    return {"ok": True}



@app.post("/tts-clone-stream")
def tts_clone_stream(req: CloneTTSRequest):
    text = req.text.strip()
    ref_text = req.ref_text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="text is required")
    if not ref_text:
        raise HTTPException(status_code=400, detail="reference transcript is required")
    if not req.ref_audio:
        raise HTTPException(status_code=400, detail="reference audio path is required")

    max_tokens, max_duration = generation_limits(text)
    sample_rate = 24000

    def generate_audio():
        total_samples = 0

        with _clone_lock:
            model = load_clone_tts()
            model_sample_rate = int(getattr(model, "sample_rate", sample_rate))

            for result in model.generate(
                text=text,
                language=req.language or "Auto",
                ref_audio=req.ref_audio,
                ref_text=ref_text,
                max_tokens=max_tokens,
                stream=True,
                streaming_interval=0.32,
            ):
                audio = np.asarray(result.audio, dtype=np.float32).reshape(-1)
                if audio.size == 0:
                    continue

                total_samples += int(audio.size)
                duration = total_samples / float(model_sample_rate)
                if duration > max_duration:
                    raise RuntimeError(
                        f"RUNAWAY_AUDIO: streamed {duration:.1f}s "
                        f"(limit {max_duration:.1f}s)"
                    )

                yield stream_pcm16(audio, model_sample_rate, text)

    return StreamingResponse(
        generate_audio(),
        media_type="application/octet-stream",
        headers={
            "X-VoiceBridge-Format": "s16le",
            "X-VoiceBridge-Sample-Rate": str(sample_rate),
            "X-VoiceBridge-Channels": "1",
        },
    )

@app.post("/tts-clone")
def tts_clone(req: CloneTTSRequest):
    text = req.text.strip()
    ref_text = req.ref_text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="text is required")
    if not ref_text:
        raise HTTPException(status_code=400, detail="reference transcript is required")
    if not req.ref_audio:
        raise HTTPException(status_code=400, detail="reference audio path is required")

    max_tokens, _ = generation_limits(text)
    with _clone_lock:
        model = load_clone_tts()
        results = list(
            model.generate(
                text=text,
                language=req.language or "Auto",
                ref_audio=req.ref_audio,
                ref_text=ref_text,
                max_tokens=max_tokens,
            )
        )
        if not results:
            raise HTTPException(status_code=500, detail="voice clone returned no audio")
        result = results[0]
        sample_rate = int(getattr(result, "sample_rate", getattr(model, "sample_rate", 24000)))
        token_count = int(getattr(result, "token_count", 0) or 0)
        data = wav_bytes(result.audio, sample_rate, text, token_count, max_tokens)

    return Response(content=data, media_type="audio/wav")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8321)
    args = parser.parse_args()
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
