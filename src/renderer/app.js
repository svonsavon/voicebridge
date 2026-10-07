const $ = (id) => document.getElementById(id);

let audioContext = null;
let mediaStream = null;
let workletNode = null;
let listening = false;
let muted = false;
let settings = {};

let speechActive = false;
let chunks = [];
let preRoll = [];
let silenceMs = 0;
let speechMs = 0;
let sumRms = 0;
let rmsFrames = 0;
let peakRms = 0;
let noiseFloor = 0.0015;
let hotFrames = 0;
let pcmFramesSeen = 0;
let remoteMuted = false;
let localHotkeyMuted = false;

function log(text, level = 'info') {
  const row = document.createElement('div');
  row.className = level;
  row.textContent = `${new Date().toLocaleTimeString()}  ${text}`;
  $('statusLog').prepend(row);
}

function recomputeMuteUi() {
  muted = remoteMuted || localHotkeyMuted;
  $('muteButton').textContent = muted ? 'Muted' : 'Mute';
  $('muteButton').classList.toggle('muted', muted);
  if (muted) resetUtterance();
}

function updateMuteUi(state) {
  remoteMuted = !!state.muted;
  recomputeMuteUi();
}

async function loadSettings() {
  settings = await window.voiceBridge.getSettings();
  $('guildId').value = settings.guildId || '';
  $('channelId').value = settings.channelId || '';
  $('whisperLanguage').value = settings.whisperLanguage || 'en';
  $('speechSilenceMs').value = settings.speechSilenceMs || 650;
  $('speechMinMs').value = settings.speechMinMs || 280;
  $('vadSensitivity').value = settings.vadSensitivity || 2.4;
  if (settings.discordTokenConfigured) $('discordToken').placeholder = 'Saved securely — leave blank to keep it';
}

async function saveSettings() {
  const patch = {
    guildId: $('guildId').value.trim(),
    channelId: $('channelId').value.trim(),
    whisperLanguage: $('whisperLanguage').value,
    aivisSpeakerId: $('speakerId').value,
    speechSilenceMs: Number($('speechSilenceMs').value || 650),
    speechMinMs: Number($('speechMinMs').value || 280),
    vadSensitivity: Number($('vadSensitivity').value || 2.8)
  };
  const token = $('discordToken').value.trim();
  if (token) patch.discordToken = token;
  settings = await window.voiceBridge.saveSettings(patch);
  $('discordToken').value = '';
  log('Settings saved.', 'ok');
}

async function refreshVoices() {
  try {
    const voices = await window.voiceBridge.refreshVoices();
    const select = $('speakerId');
    select.innerHTML = '';
    for (const v of voices) {
      const option = document.createElement('option');
      option.value = v.id;
      option.textContent = v.name;
      if (String(settings.aivisSpeakerId || '') === String(v.id)) option.selected = true;
      select.appendChild(option);
    }
    if (!voices.length) select.innerHTML = '<option value="">No voices returned</option>';
    log(`Loaded ${voices.length} local AivisSpeech styles.`, 'ok');
  } catch (err) {
    log(`AivisSpeech is not reachable: ${err.message}`, 'warn');
  }
}

function resetUtterance() {
  speechActive = false;
  chunks = [];
  preRoll = [];
  silenceMs = 0;
  speechMs = 0;
  sumRms = 0;
  rmsFrames = 0;
  peakRms = 0;
  hotFrames = 0;
}

function rmsOf(samples) {
  let total = 0;
  for (let i = 0; i < samples.length; i++) total += samples[i] * samples[i];
  return Math.sqrt(total / samples.length);
}

function flatten(arrays) {
  let length = 0;
  for (const a of arrays) length += a.length;
  const out = new Float32Array(length);
  let offset = 0;
  for (const a of arrays) { out.set(a, offset); offset += a.length; }
  return out;
}

function encodeWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const write = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  write(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const x = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, x < 0 ? x * 0x8000 : x * 0x7fff, true);
  }
  return new Uint8Array(buffer);
}

async function finalizeUtterance() {
  if (!speechActive) return;
  const utteranceChunks = chunks;
  const durationMs = speechMs;
  const avgRms = rmsFrames ? sumRms / rmsFrames : 0;
  const peak = peakRms;
  resetUtterance();

  const minimum = Number(settings.speechMinMs || 280);
  if (durationMs < minimum || muted) return;

  const pcm = flatten(utteranceChunks);
  const wav = encodeWav(pcm, audioContext.sampleRate);
  try {
    await window.voiceBridge.processUtterance(wav, {
      durationMs,
      avgRms,
      peakRms: peak
    });
  } catch (err) {
    log(err.message, 'error');
  }
}

function handlePcm(samples) {
  if (!listening || muted) return;
  const frameMs = (samples.length / audioContext.sampleRate) * 1000;
  const rms = rmsOf(samples);
  $('meterFill').style.width = `${Math.min(100, rms * 1200)}%`;

  pcmFramesSeen += 1;
  if (pcmFramesSeen === 1) log(`Microphone PCM is flowing at ${audioContext.sampleRate} Hz.`, 'ok');

  const sensitivity = Number(settings.vadSensitivity || 2.4);
  const threshold = Math.max(0.0025, noiseFloor * sensitivity);
  const hot = rms > threshold;

  if (!speechActive && !hot) noiseFloor = noiseFloor * 0.995 + rms * 0.005;

  const maxPreRollFrames = Math.ceil((audioContext.sampleRate * 0.22) / samples.length);
  preRoll.push(samples);
  if (preRoll.length > maxPreRollFrames) preRoll.shift();

  if (!speechActive) {
    hotFrames = hot ? hotFrames + 1 : Math.max(0, hotFrames - 1);
    if (hotFrames >= 2) {
      speechActive = true;
      chunks = preRoll.slice();
      speechMs = preRoll.length * frameMs;
      sumRms = rms;
      rmsFrames = 1;
      peakRms = rms;
      silenceMs = 0;
    }
    return;
  }

  chunks.push(samples);
  speechMs += frameMs;
  sumRms += rms;
  rmsFrames += 1;
  peakRms = Math.max(peakRms, rms);

  if (rms < threshold * 0.7) silenceMs += frameMs;
  else silenceMs = 0;

  if (silenceMs >= Number(settings.speechSilenceMs || 650) || speechMs >= Number(settings.speechMaxMs || 12000)) {
    finalizeUtterance();
  }
}

async function startListening() {
  if (listening) return;

  // Create/resume from the button gesture first. Chromium may otherwise leave
  // the context suspended after an async macOS permission prompt.
  audioContext = new AudioContext({ latencyHint: 'interactive' });
  try { await audioContext.resume(); } catch {}

  const granted = await window.voiceBridge.requestMicrophone();
  if (!granted) throw new Error('Microphone permission was not granted.');

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    },
    video: false
  });
  if (audioContext.state !== 'running') await audioContext.resume();
  const workletUrl = new URL('pcm-worklet.js', window.location.href).href;
  await audioContext.audioWorklet.addModule(workletUrl);
  const source = audioContext.createMediaStreamSource(mediaStream);
  workletNode = new AudioWorkletNode(audioContext, 'pcm-processor');
  workletNode.port.onmessage = (event) => handlePcm(new Float32Array(event.data));
  source.connect(workletNode);
  // Keep worklet alive without audible playback.
  const silent = audioContext.createGain();
  silent.gain.value = 0;
  workletNode.connect(silent).connect(audioContext.destination);

  if (audioContext.state !== 'running') await audioContext.resume();
  listening = true;
  pcmFramesSeen = 0;
  const track = mediaStream.getAudioTracks()[0];
  log(`Mic opened: ${track?.label || 'default input'}; AudioContext=${audioContext.state}.`, 'info');
  setTimeout(() => {
    if (listening && pcmFramesSeen === 0) {
      log(`No microphone PCM received after 1.5 s (AudioContext=${audioContext?.state || 'closed'}). Stop/start listening once; if it persists, check System Settings → Privacy & Security → Microphone → VoiceBridge.`, 'error');
    }
  }, 1500);
  $('listenButton').textContent = 'Stop listening';
  $('liveBadge').textContent = 'always listening';
  $('liveBadge').className = 'badge on';
  log('Always-listening microphone capture started locally.', 'ok');
}

async function stopListening() {
  listening = false;
  resetUtterance();
  try { workletNode?.disconnect(); } catch {}
  try { mediaStream?.getTracks().forEach((t) => t.stop()); } catch {}
  try { await audioContext?.close(); } catch {}
  workletNode = null;
  mediaStream = null;
  audioContext = null;
  pcmFramesSeen = 0;
  $('listenButton').textContent = 'Start always listening';
  $('liveBadge').textContent = 'stopped';
  $('liveBadge').className = 'badge off';
  $('meterFill').style.width = '0%';
  log('Microphone capture stopped.');
}

$('listenButton').addEventListener('click', async () => {
  try { listening ? await stopListening() : await startListening(); }
  catch (err) { log(err.message, 'error'); }
});

$('muteButton').addEventListener('click', async () => {
  const result = await window.voiceBridge.setManualMute(!remoteMuted);
  updateMuteUi(result);
});
$('saveButton').addEventListener('click', saveSettings);
$('refreshVoices').addEventListener('click', refreshVoices);
$('launchAivis').addEventListener('click', async () => {
  await window.voiceBridge.launchAivis();
  log('Asked macOS to launch AivisSpeech.');
});
$('testVoice').addEventListener('click', async () => {
  try { await saveSettings(); await window.voiceBridge.testVoice('VoiceBridge is ready.'); }
  catch (err) { log(err.message, 'error'); }
});
$('connectButton').addEventListener('click', async () => {
  try { await saveSettings(); const r = await window.voiceBridge.connectDiscord(); log(`Connected to ${r.guildName} / ${r.channelName}.`, 'ok'); }
  catch (err) { log(err.message, 'error'); }
});
$('disconnectButton').addEventListener('click', async () => window.voiceBridge.disconnectDiscord());

// Focused-window fallback for F8. The native helper makes it global; this
// gives immediate feedback while VoiceBridge itself is active.
window.addEventListener('keydown', (event) => {
  if (event.code === 'F8' && !event.repeat) {
    localHotkeyMuted = true;
    recomputeMuteUi();
  }
});
window.addEventListener('keyup', (event) => {
  if (event.code === 'F8') {
    localHotkeyMuted = false;
    recomputeMuteUi();
  }
});
window.addEventListener('blur', () => {
  // The native helper owns global state. Do not leave the focused fallback stuck.
  localHotkeyMuted = false;
  recomputeMuteUi();
});

window.voiceBridge.onStatus((s) => {
  log(s.text, s.level);
  if (s.level === 'transcript' && s.text.startsWith('You: ')) $('transcript').textContent = s.text.slice(5);
});
window.voiceBridge.onMuteState(updateMuteUi);

(async () => {
  await loadSettings();
  const state = await window.voiceBridge.getState();
  updateMuteUi({ muted: state.muted });
  await refreshVoices();
})();


// ---- updater UI ----
function renderUpdateState(u) {
  if (!u) return;
  const status = document.getElementById('updateStatus');
  const download = document.getElementById('downloadUpdate');
  const install = document.getElementById('installUpdate');
  const release = document.getElementById('openRelease');
  if (status) status.textContent = u.message || `VoiceBridge ${u.currentVersion || ''}`;
  download?.classList.add('hidden'); install?.classList.add('hidden'); release?.classList.add('hidden');
  if (u.phase === 'available' && u.canInstall) download?.classList.remove('hidden');
  if (u.phase === 'ready') install?.classList.remove('hidden');
  if (u.phase === 'available-unsigned') release?.classList.remove('hidden');
}

document.getElementById('checkUpdates')?.addEventListener('click', async () => {
  try { await window.voiceBridge.checkForUpdates(); } catch (err) { log(`Updater: ${err.message}`, 'error'); }
});
document.getElementById('downloadUpdate')?.addEventListener('click', async () => {
  try { await window.voiceBridge.downloadUpdate(); } catch (err) { log(`Updater: ${err.message}`, 'error'); }
});
document.getElementById('installUpdate')?.addEventListener('click', async () => {
  try { await window.voiceBridge.installUpdate(); } catch (err) { log(`Updater: ${err.message}`, 'error'); }
});
document.getElementById('openRelease')?.addEventListener('click', async () => {
  try { await window.voiceBridge.openLatestRelease(); } catch (err) { log(`Updater: ${err.message}`, 'error'); }
});
window.voiceBridge.onUpdateState(renderUpdateState);
window.voiceBridge.getUpdateState().then((u) => renderUpdateState({
  ...u,
  phase: 'idle',
  message: u.developerSigned
    ? `VoiceBridge ${u.currentVersion} — signed updater ready.`
    : `VoiceBridge ${u.currentVersion} — update checking ready; auto-install starts with the first signed build.`
})).catch(() => {});
