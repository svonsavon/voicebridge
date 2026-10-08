const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

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
  translate,
  synthesize,
  prepareClone,
  synthesizeClone,
  shutdown,
  runtimeRoot
};
