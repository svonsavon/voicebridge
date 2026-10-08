const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { app } = require('electron');

function ffmpegPath() {
  let p = require('ffmpeg-static');
  if (p && p.includes('app.asar')) p = p.replace('app.asar', 'app.asar.unpacked');
  return p;
}

function profileDir() {
  return path.join(app.getPath('userData'), 'voice-profiles', 'my-voice');
}

function audioPath() {
  return path.join(profileDir(), 'reference.wav');
}

function metadataPath() {
  return path.join(profileDir(), 'profile.json');
}

function getProfile() {
  try {
    const meta = JSON.parse(fs.readFileSync(metadataPath(), 'utf8'));
    const hasAudio = fs.existsSync(audioPath());
    const refText = String(meta.refText || '').trim();
    return {
      configured: hasAudio && !!refText,
      hasAudio,
      name: meta.name || 'My Voice',
      refText,
      audioPath: hasAudio ? audioPath() : '',
      createdAt: meta.createdAt || null
    };
  } catch {
    return {
      configured: false,
      hasAudio: fs.existsSync(audioPath()),
      refText: '',
      audioPath: fs.existsSync(audioPath()) ? audioPath() : ''
    };
  }
}

function normalizeAudio(sourcePath, destinationPath) {
  return new Promise((resolve, reject) => {
    const tmp = destinationPath + '.tmp.wav';
    const ff = spawn(ffmpegPath(), [
      '-y',
      '-hide_banner',
      '-loglevel', 'error',
      '-i', sourcePath,
      '-ar', '24000',
      '-ac', '1',
      '-c:a', 'pcm_s16le',
      tmp
    ], { stdio: ['ignore', 'ignore', 'pipe'] });

    let stderr = '';
    ff.stderr.on('data', (d) => { stderr += d.toString(); });
    ff.on('error', reject);
    ff.on('exit', (code) => {
      if (code !== 0) {
        try { fs.unlinkSync(tmp); } catch {}
        reject(new Error(stderr.trim() || ('ffmpeg exited with code ' + code)));
        return;
      }
      fs.renameSync(tmp, destinationPath);
      resolve();
    });
  });
}

async function importReference(sourcePath, refText = '') {
  const transcript = String(refText || '').trim();
  if (!sourcePath || !fs.existsSync(sourcePath)) throw new Error('Reference audio file was not found.');

  fs.mkdirSync(profileDir(), { recursive: true });
  await normalizeAudio(sourcePath, audioPath());

  const existing = getProfile();
  const meta = {
    name: 'My Voice',
    refText: transcript || existing.refText || '',
    createdAt: new Date().toISOString()
  };
  fs.writeFileSync(metadataPath(), JSON.stringify(meta, null, 2), { mode: 0o600 });

  return getProfile();
}

function setTranscript(refText) {
  const transcript = String(refText || '').trim();
  if (!fs.existsSync(audioPath())) {
    throw new Error('Choose a reference recording first.');
  }
  if (!transcript) {
    throw new Error('Enter the exact transcript of the reference recording.');
  }

  const current = getProfile();
  const meta = {
    name: 'My Voice',
    refText: transcript,
    createdAt: current.createdAt || new Date().toISOString()
  };
  fs.writeFileSync(metadataPath(), JSON.stringify(meta, null, 2), { mode: 0o600 });
  return getProfile();
}

module.exports = { getProfile, importReference, setTranscript, profileDir, audioPath };
