const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const HOST = '127.0.0.1';
const PORT = 8080;
const BASE_URL = `http://${HOST}:${PORT}`;
let child = null;

function runtimeRoot() {
  return path.join(os.homedir(), 'Library', 'Application Support', 'VoiceBridge', 'runtime');
}

function defaultBinary() {
  return path.join(runtimeRoot(), 'bin', 'whisper-server');
}

function defaultModel() {
  return path.join(runtimeRoot(), 'models', 'ggml-small.bin');
}

function defaultVadModel() {
  return path.join(runtimeRoot(), 'models', 'ggml-silero-v6.2.0.bin');
}

async function healthy(timeoutMs = 1000) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(`${BASE_URL}/`, { signal: controller.signal });
    clearTimeout(timer);
    // whisper-server commonly returns its UI or a 404 for /. Either proves
    // that the HTTP listener is up; only 5xx means it is unhealthy.
    return response.status < 500;
  } catch {
    return false;
  }
}

async function ensureServer(onLog = () => {}) {
  if (await healthy()) return { ok: true, external: true };

  const binary = defaultBinary();
  const model = defaultModel();
  if (!fs.existsSync(binary) || !fs.existsSync(model)) {
    return {
      ok: false,
      reason: 'Whisper runtime is not installed. Run npm run setup:runtime on the Mac once.'
    };
  }

  let outputTail = '';
  let exited = false;
  let exitCode = null;
  const keepTail = (chunk) => {
    const text = chunk.toString();
    outputTail = (outputTail + text).slice(-6000);
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) onLog(`[whisper] ${line.trim()}`);
    }
  };

  const args = [
    '--host', HOST,
    '--port', String(PORT),
    '-m', model
  ];
  const vadModel = defaultVadModel();
  if (fs.existsSync(vadModel)) {
    args.push(
      '--vad',
      '--vad-model', vadModel,
      '--vad-threshold', '0.58',
      '--vad-min-speech-duration-ms', '220',
      '--vad-min-silence-duration-ms', '100',
      '--vad-speech-pad-ms', '40'
    );
    onLog('[whisper] Silero VAD enabled.');
  } else {
    onLog('[whisper] Silero VAD model missing; using VoiceBridge front-end VAD only.');
  }

  child = spawn(binary, args, {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  child.stdout.on('data', keepTail);
  child.stderr.on('data', keepTail);
  child.on('error', (err) => {
    outputTail = (outputTail + `\nspawn error: ${err.message}`).slice(-6000);
    exited = true;
    exitCode = 'spawn-error';
  });
  child.on('exit', (code, signal) => {
    exited = true;
    exitCode = code ?? signal ?? 'unknown';
    onLog(`[whisper] exited (${exitCode})`);
    child = null;
  });

  // The previous 7.5 s timeout was too aggressive. Loading ggml-small and
  // initializing Metal can exceed that, especially on first launch.
  const deadline = Date.now() + 60_000;
  let nextProgress = Date.now() + 5_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 350));
    if (await healthy(700)) return { ok: true, external: false };
    if (exited) {
      const detail = outputTail.trim().split(/\r?\n/).slice(-8).join(' | ');
      return {
        ok: false,
        reason: `whisper-server exited before becoming ready (${exitCode}).${detail ? ` ${detail}` : ''}`
      };
    }
    if (Date.now() >= nextProgress) {
      onLog('[whisper] still loading model / initializing Metal…');
      nextProgress += 5_000;
    }
  }

  const detail = outputTail.trim().split(/\r?\n/).slice(-8).join(' | ');
  return {
    ok: false,
    reason: `whisper-server was still not reachable after 60 seconds.${detail ? ` ${detail}` : ''}`
  };
}

async function transcribe(wavBytes, language = 'en', { translateToEnglish = false } = {}) {
  const form = new FormData();
  const blob = new Blob([Buffer.from(wavBytes)], { type: 'audio/wav' });
  form.append('file', blob, 'utterance.wav');
  form.append('temperature', '0.0');
  form.append('response_format', 'json');
  form.append('no_timestamps', 'true');
  form.append('suppress_nst', 'true');
  form.append('translate', translateToEnglish ? 'true' : 'false');
  form.append('token_timestamps', 'false');
  if (fs.existsSync(defaultVadModel())) {
    form.append('vad', 'true');
    form.append('vad_threshold', '0.58');
    form.append('vad_min_speech_duration_ms', '220');
    form.append('vad_min_silence_duration_ms', '100');
    form.append('vad_speech_pad_ms', '40');
  }
  // Slightly stricter than whisper.cpp's default. Combined with VAD, this
  // helps reject mostly-silent clips that would otherwise hallucinate a word.
  form.append('no_speech_thold', '0.50');
  if (language) form.append('language', language);

  const response = await fetch(`${BASE_URL}/inference`, {
    method: 'POST',
    body: form
  });
  if (!response.ok) throw new Error(`Whisper HTTP ${response.status}: ${await response.text()}`);

  const data = await response.json();
  const text = String(data.text ?? data.transcription ?? '').trim();
  return text.replace(/^\s+|\s+$/g, '');
}

function shutdown() {
  if (child && !child.killed) child.kill('SIGTERM');
  child = null;
}

module.exports = {
  ensureServer,
  transcribe,
  shutdown,
  runtimeRoot,
  defaultBinary,
  defaultModel,
  defaultVadModel
};
