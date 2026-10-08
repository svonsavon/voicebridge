const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Readable } = require('node:stream');

const HOST = '127.0.0.1';
const PORT = 8321;
const BASE_URL = `http://${HOST}:${PORT}`;

let child = null;
let starting = null;

function runtimeRoot() {
  return path.join(os.homedir(), 'Library', 'Application Support', 'VoiceBridge', 'qwen-runtime');
}

function pythonPath() {
  return path.join(runtimeRoot(), '.venv', 'bin', 'python');
}

function serverPath() {
  return path.join(runtimeRoot(), 'qwen_server.py');
}

async function healthy(timeoutMs = 1000) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(`${BASE_URL}/health`, { signal: controller.signal });
    clearTimeout(timer);
    return response.ok;
  } catch {
    return false;
  }
}

async function ensureServer(onLog = () => {}) {
  if (await healthy()) return { ok: true, external: true };
  if (starting) return starting;

  starting = (async () => {
    const python = pythonPath();
    const server = serverPath();

    if (!fs.existsSync(python) || !fs.existsSync(server)) {
      return {
        ok: false,
        reason: 'Qwen multilingual runtime is not installed. Run npm run setup:qwen once.'
      };
    }

    let exited = false;
    let outputTail = '';

    child = spawn(python, [server, '--host', HOST, '--port', String(PORT)], {
      cwd: runtimeRoot(),
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const keepTail = (chunk) => {
      const text = chunk.toString();
      outputTail = (outputTail + text).slice(-8000);
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) onLog(`[qwen] ${line.trim()}`);
      }
    };

    child.stdout.on('data', keepTail);
    child.stderr.on('data', keepTail);
    child.on('error', keepTail);
    child.on('exit', (code, signal) => {
      exited = true;
      onLog(`[qwen] exited (${code ?? signal ?? 'unknown'})`);
      child = null;
    });

    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (await healthy(1200)) return { ok: true, external: false };
      if (exited) {
        const detail = outputTail.trim().split(/\r?\n/).slice(-6).join(' | ');
        return {
          ok: false,
          reason: `Qwen runtime exited before becoming ready.${detail ? ` ${detail}` : ''}`
        };
      }
    }

    return {
      ok: false,
      reason: 'Qwen runtime did not become ready within 120 seconds.'
    };
  })();

  try {
    return await starting;
  } finally {
    starting = null;
  }
}

async function requestJson(pathname, options = {}) {
  const response = await fetch(`${BASE_URL}${pathname}`, options);
  if (!response.ok) throw new Error(`Qwen runtime HTTP ${response.status}: ${await response.text()}`);
  return response.json();
}

async function getVoices() {
  return requestJson('/voices');
}

async function verifySpeaker(wavBytes, { refAudio, threshold = 0.45 } = {}) {
  const url = new URL(`${BASE_URL}/speaker-verify`);
  url.searchParams.set('ref_audio', refAudio || '');
  url.searchParams.set('threshold', String(threshold));

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'audio/wav' },
    body: Buffer.from(wavBytes)
  });
  if (!response.ok) {
    throw new Error(`Speaker verification HTTP ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

async function translate(text, source, target) {
  const data = await requestJson('/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, source, target })
  });
  return String(data.text || '').trim();
}

async function synthesize(text, { language = 'Auto', voice = 'Ryan' } = {}) {
  const response = await fetch(`${BASE_URL}/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, language, voice })
  });
  if (!response.ok) throw new Error(`Qwen TTS HTTP ${response.status}: ${await response.text()}`);
  return Buffer.from(await response.arrayBuffer());
}

async function prepareClone({ refAudio, refText } = {}) {
  const data = await requestJson('/prepare-clone', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ref_audio: refAudio,
      ref_text: refText
    })
  });
  return !!data.ok;
}

async function synthesizeCloneStream(
  text,
  {
    language = 'Auto',
    refAudio,
    refText,
    onFirstAudio = () => {},
    firstAudioTimeoutMs = 30_000,
    stallTimeoutMs = 8_000
  } = {}
) {
  const controller = new AbortController();
  let watchdog = null;

  const armWatchdog = (ms, message) => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      try { controller.abort(new Error(message)); } catch {}
    }, Math.max(3_000, Number(ms)));
  };

  armWatchdog(firstAudioTimeoutMs, 'TTS stream did not produce first audio in time.');

  let response;
  try {
    response = await fetch(`${BASE_URL}/tts-clone-stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        language,
        ref_audio: refAudio,
        ref_text: refText
      }),
      signal: controller.signal
    });
  } catch (err) {
    clearTimeout(watchdog);
    throw err;
  }
  if (!response.ok) {
    clearTimeout(watchdog);
    throw new Error(`Qwen clone stream HTTP ${response.status}: ${await response.text()}`);
  }
  if (!response.body) {
    clearTimeout(watchdog);
    throw new Error('Qwen clone stream returned no body.');
  }

  const sampleRate = Number(response.headers.get('x-voicebridge-sample-rate') || 24000);
  const channels = Number(response.headers.get('x-voicebridge-channels') || 1);
  const reader = response.body.getReader();

  let first = true;
  let resolveDone;
  let rejectDone;
  let completedSettled = false;
  const completed = new Promise((resolve, reject) => {
    resolveDone = () => {
      if (completedSettled) return;
      completedSettled = true;
      resolve();
    };
    rejectDone = (err) => {
      if (completedSettled) return;
      completedSettled = true;
      reject(err);
    };
  });

  async function* chunks() {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value?.byteLength) continue;

        // Generation can legitimately run for a long time on long sentences.
        // Only abort if it stops making progress.
        armWatchdog(stallTimeoutMs, 'TTS stream stalled.');

        if (first) {
          first = false;
          try { onFirstAudio(); } catch {}
        }
        yield Buffer.from(value);
      }
      resolveDone();
    } catch (err) {
      rejectDone(err);
      throw err;
    } finally {
      clearTimeout(watchdog);
      try { reader.releaseLock(); } catch {}
    }
  }

  const stream = Readable.from(chunks());

  const cancel = (reason = 'interrupted') => {
    clearTimeout(watchdog);
    const err = new Error(reason);
    err.code = 'VOICEBRIDGE_INTERRUPTED';
    rejectDone(err);
    try { controller.abort(err); } catch {}
    try { reader.cancel(reason); } catch {}
    try { stream.destroy(err); } catch {}
  };

  return {
    stream,
    sampleRate,
    channels,
    completed,
    cancel
  };
}

async function synthesizeClone(text, { language = 'Auto', refAudio, refText } = {}) {
  const response = await fetch(`${BASE_URL}/tts-clone`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      language,
      ref_audio: refAudio,
      ref_text: refText
    })
  });
  if (!response.ok) throw new Error(`Qwen clone TTS HTTP ${response.status}: ${await response.text()}`);
  return Buffer.from(await response.arrayBuffer());
}

function shutdown() {
  if (child && !child.killed) {
    try { child.kill('SIGTERM'); } catch {}
  }
  child = null;
  starting = null;
}

module.exports = {
  ensureServer,
  healthy,
  getVoices,
  verifySpeaker,
  translate,
  synthesize,
  prepareClone,
  synthesizeCloneStream,
  synthesizeClone,
  shutdown,
  runtimeRoot
};
