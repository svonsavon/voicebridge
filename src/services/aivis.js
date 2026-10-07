const { spawn } = require('node:child_process');

const BASE_URL = 'http://127.0.0.1:10101';

async function getSpeakers() {
  const response = await fetch(`${BASE_URL}/speakers`);
  if (!response.ok) throw new Error(`AivisSpeech HTTP ${response.status}`);
  const speakers = await response.json();
  const rows = [];
  for (const speaker of speakers) {
    for (const style of speaker.styles || []) {
      rows.push({
        id: String(style.id),
        name: `${speaker.name} — ${style.name}`,
        speakerName: speaker.name,
        styleName: style.name
      });
    }
  }
  return rows;
}

function clamp(x, min, max) {
  return Math.max(min, Math.min(max, x));
}

function inferExpression(text, prosody = {}) {
  let speedScale = 1.0;
  let intonationScale = 1.0;
  let volumeScale = 1.0;

  const exclamations = (text.match(/!/g) || []).length;
  const questions = (text.match(/\?/g) || []).length;
  const hasEllipsis = /\.\.\.|…/.test(text);
  const upperLetters = (text.match(/[A-Z]/g) || []).length;
  const letters = (text.match(/[A-Za-z]/g) || []).length;
  const upperRatio = letters ? upperLetters / letters : 0;

  if (exclamations) {
    intonationScale += Math.min(0.25, exclamations * 0.08);
    speedScale += 0.04;
  }
  if (questions) intonationScale += 0.08;
  if (hasEllipsis) speedScale -= 0.08;
  if (upperRatio > 0.65 && letters >= 5) {
    volumeScale += 0.08;
    intonationScale += 0.12;
  }

  // Only derived numerical prosody leaves the microphone stage; raw source audio does not.
  const peak = Number(prosody.peakRms || 0);
  const avg = Number(prosody.avgRms || 0);
  const durationMs = Number(prosody.durationMs || 0);
  if (peak > 0.16 || avg > 0.07) {
    volumeScale += 0.05;
    intonationScale += 0.08;
  }
  if (durationMs > 0 && text.length > 8) {
    const charsPerSecond = text.length / (durationMs / 1000);
    if (charsPerSecond > 15) speedScale += 0.07;
    if (charsPerSecond < 7) speedScale -= 0.05;
  }

  return {
    speedScale: clamp(speedScale, 0.82, 1.18),
    intonationScale: clamp(intonationScale, 0.85, 1.35),
    volumeScale: clamp(volumeScale, 0.88, 1.15)
  };
}

async function synthesize(text, speakerId, prosody = {}) {
  if (!speakerId) throw new Error('Choose an AivisSpeech voice/style first.');
  const queryUrl = new URL(`${BASE_URL}/audio_query`);
  queryUrl.searchParams.set('text', text);
  queryUrl.searchParams.set('speaker', String(speakerId));

  const queryResponse = await fetch(queryUrl, { method: 'POST' });
  if (!queryResponse.ok) throw new Error(`Aivis audio_query HTTP ${queryResponse.status}: ${await queryResponse.text()}`);
  const query = await queryResponse.json();

  const expression = inferExpression(text, prosody);
  if ('speedScale' in query) query.speedScale = expression.speedScale;
  if ('intonationScale' in query) query.intonationScale = expression.intonationScale;
  if ('volumeScale' in query) query.volumeScale = expression.volumeScale;

  const synthesisUrl = new URL(`${BASE_URL}/synthesis`);
  synthesisUrl.searchParams.set('speaker', String(speakerId));
  const response = await fetch(synthesisUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(query)
  });
  if (!response.ok) throw new Error(`Aivis synthesis HTTP ${response.status}: ${await response.text()}`);
  return Buffer.from(await response.arrayBuffer());
}

function launchAivis() {
  return new Promise((resolve) => {
    const p = spawn('/usr/bin/open', ['-gj', '-a', 'AivisSpeech'], { detached: true, stdio: 'ignore' });
    p.on('error', () => resolve(false));
    p.on('spawn', () => {
      p.unref();
      resolve(true);
    });
  });
}

module.exports = { getSpeakers, synthesize, inferExpression, launchAivis };
