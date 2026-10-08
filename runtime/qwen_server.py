#!/usr/bin/env python3
import argparse
import gc
import io
import os
import re
import threading
import wave

import numpy as np
import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel

TRANSLATION_MODEL = "Qwen/Qwen3-0.6B-MLX-4bit"
TTS_MODEL = "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit"
CLONE_MODEL = "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-8bit"
SPEAKER_MODEL = os.path.join(
    os.path.dirname(__file__),
    "models",
    "wespeaker_en_voxceleb_resnet34.onnx",
)

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
_speaker_extractor = None
_speaker_reference_cache = {}
_translation_lock = threading.Lock()
_tts_lock = threading.Lock()
_clone_lock = threading.Lock()
_speaker_lock = threading.Lock()


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
    naturalize: bool = True


class PrepareCloneRequest(BaseModel):
    ref_audio: str
    ref_text: str
    naturalize: bool = True


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


def load_speaker_extractor():
    global _speaker_extractor
    if _speaker_extractor is None:
        if not os.path.exists(SPEAKER_MODEL):
            raise HTTPException(
                status_code=503,
                detail="speaker verification model is not installed",
            )
        try:
            import sherpa_onnx
        except Exception as exc:
            raise HTTPException(
                status_code=503,
                detail=f"sherpa-onnx is not installed: {exc}",
            )

        config = sherpa_onnx.SpeakerEmbeddingExtractorConfig(
            model=SPEAKER_MODEL,
            num_threads=2,
            debug=False,
            provider="cpu",
        )
        if not config.validate():
            raise HTTPException(
                status_code=500,
                detail="invalid speaker embedding model configuration",
            )
        _speaker_extractor = sherpa_onnx.SpeakerEmbeddingExtractor(config)
    return _speaker_extractor


def read_wav_samples(data: bytes):
    try:
        with wave.open(io.BytesIO(data), "rb") as handle:
            channels = handle.getnchannels()
            sample_width = handle.getsampwidth()
            sample_rate = handle.getframerate()
            frames = handle.readframes(handle.getnframes())
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"invalid WAV audio: {exc}")

    if sample_width == 2:
        samples = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
    elif sample_width == 1:
        samples = (np.frombuffer(frames, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    elif sample_width == 4:
        samples = np.frombuffer(frames, dtype="<i4").astype(np.float32) / 2147483648.0
    else:
        raise HTTPException(
            status_code=400,
            detail=f"unsupported WAV sample width: {sample_width}",
        )

    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)

    return np.ascontiguousarray(samples, dtype=np.float32), int(sample_rate)


def speaker_embedding(samples, sample_rate: int):
    extractor = load_speaker_extractor()
    if samples.size < max(1, int(sample_rate * 0.25)):
        raise HTTPException(status_code=422, detail="speaker sample is too short")

    stream = extractor.create_stream()
    stream.accept_waveform(sample_rate=sample_rate, waveform=samples)
    stream.input_finished()
    if not extractor.is_ready(stream):
        raise HTTPException(status_code=422, detail="speaker sample is too short for embedding")

    embedding = np.asarray(extractor.compute(stream), dtype=np.float32)
    norm = float(np.linalg.norm(embedding))
    if not np.isfinite(norm) or norm <= 0:
        raise HTTPException(status_code=500, detail="invalid speaker embedding")
    return embedding / norm


def reference_speaker_embedding(path: str):
    try:
        stat = os.stat(path)
    except OSError as exc:
        raise HTTPException(status_code=400, detail=f"reference voice is unavailable: {exc}")

    key = (path, stat.st_mtime_ns, stat.st_size)
    cached = _speaker_reference_cache.get(key)
    if cached is not None:
        return cached

    with open(path, "rb") as handle:
        samples, sample_rate = read_wav_samples(handle.read())
    embedding = speaker_embedding(samples, sample_rate)

    _speaker_reference_cache.clear()
    _speaker_reference_cache[key] = embedding
    return embedding


def strip_thinking(text: str) -> str:
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.S | re.I)
    return text.strip().strip('"').strip()


def generation_limits(text: str):
    # Keep short utterances tightly bounded to contain no-EOS runaways, but let
    # genuinely long conversational turns finish normally.
    chars = max(1, len(text.strip()))
    max_tokens = min(640, max(80, chars * 5))
    max_duration = min(55.0, max(6.0, chars * 0.35 + 5.0))
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



@app.post("/speaker-verify")
async def speaker_verify(request: Request):
    ref_audio = request.query_params.get("ref_audio", "").strip()
    try:
        threshold = float(request.query_params.get("threshold", "0.45"))
    except ValueError:
        raise HTTPException(status_code=400, detail="invalid speaker threshold")

    threshold = max(0.0, min(1.0, threshold))
    if not ref_audio:
        raise HTTPException(status_code=400, detail="reference audio path is required")

    wav_data = await request.body()
    samples, sample_rate = read_wav_samples(wav_data)
    duration = samples.size / float(sample_rate)

    if duration < 0.55:
        return {
            "accepted": True,
            "skipped": True,
            "reason": "too-short",
            "duration": duration,
            "threshold": threshold,
        }

    with _speaker_lock:
        reference = reference_speaker_embedding(ref_audio)
        query = speaker_embedding(samples, sample_rate)
        score = float(np.dot(reference, query))

    return {
        "accepted": bool(score >= threshold),
        "skipped": False,
        "score": score,
        "threshold": threshold,
        "duration": duration,
    }


@app.get("/health")
def health():
    return {
        "ok": True,
        "translationLoaded": _translation_model is not None,
        "ttsLoaded": _tts_model is not None,
        "cloneLoaded": _clone_model is not None,
        "speakerVerifierReady": os.path.exists(SPEAKER_MODEL),
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

        try:
            from mlx_audio.utils import load_audio
            ref_audio = load_audio(req.ref_audio, sample_rate=model.sample_rate)

            if req.naturalize:
                # Natural mode uses only the speaker embedding. Warm the speaker
                # encoder without conditioning on the reference performance.
                model.extract_speaker_embedding(ref_audio)
            else:
                # Reference-match mode keeps full ICL conditioning.
                model._prepare_icl_generation_inputs(
                    text=".",
                    ref_audio=ref_audio,
                    ref_text=req.ref_text.strip(),
                    language="auto",
                )
        except Exception:
            # Warm-up is an optimization only; live generation remains the
            # source of truth if MLX-Audio internals change.
            pass

    return {"ok": True}



@app.post("/tts-clone-stream")
def tts_clone_stream(req: CloneTTSRequest):
    text = req.text.strip()
    ref_text = req.ref_text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="text is required")
    if not ref_text and not req.naturalize:
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
                ref_text=None if req.naturalize else ref_text,
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
                ref_text=None if req.naturalize else ref_text,
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
