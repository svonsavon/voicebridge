const $ = (id) => document.getElementById(id);

let audioContext = null;
let mediaStream = null;
let workletNode = null;
let sourceNode = null;
let silentGain = null;
let trackProcessor = null;
let trackReader = null;
let trackProcessorTask = null;
let captureSampleRate = 48000;
let capturePath = 'none';
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
let onsetHotMs = 0;
let voicedMs = 0;
let utteranceNoiseFloor = 0.0015;
let hesitationCount = 0;
let longestPauseMs = 0;
let bargeInAttempted = false;
let bargeInPromise = null;
let pcmFramesSeen = 0;
let processedFramesSeen = 0;
let remoteMuted = false;
let mainHelperMuted = false;
let mainManualMuted = false;
let localHotkeyMuted = false;

function log(text, level = 'info') {
  const row = document.createElement('div');
  row.className = level;
  row.textContent = `${new Date().toLocaleTimeString()}  ${text}`;
  $('statusLog').prepend(row);
}

function updateListeningBadge() {
  if (!listening) {
    $('liveBadge').textContent = 'stopped';
    $('liveBadge').className = 'badge off';
    return;
  }
  if (muted) {
    $('liveBadge').textContent = 'listening • muted';
    $('liveBadge').className = 'badge muted';
    return;
  }
  $('liveBadge').textContent = 'always listening';
  $('liveBadge').className = 'badge on';
}

function recomputeMuteUi() {
  muted = remoteMuted || localHotkeyMuted;
  const f8Muted = mainHelperMuted || localHotkeyMuted;
  if (f8Muted) $('muteButton').textContent = 'Muted by F8';
  else if (mainManualMuted || remoteMuted) $('muteButton').textContent = 'Unmute';
  else $('muteButton').textContent = 'Mute';
  $('muteButton').classList.toggle('muted', muted);
  updateListeningBadge();
  if (muted) resetUtterance();
}

function updateMuteUi(state) {
  remoteMuted = !!state.muted;
  mainHelperMuted = !!state.helperMuted;
  mainManualMuted = !!state.manualMuted;
  recomputeMuteUi();
}

async function loadSettings() {
  settings = await window.voiceBridge.getSettings();
  $('guildId').value = settings.guildId || '';
  $('channelId').value = settings.channelId || '';
  if ($('microphoneDevice')) $('microphoneDevice').value = settings.microphoneDeviceId || '';
  $('inputLanguage').value = settings.inputLanguage || settings.whisperLanguage || 'en';
  $('outputLanguage').value = settings.outputLanguage || 'same';
  $('englishTranslationMode').value = settings.englishTranslationMode || 'fast';
  $('ttsEngine').value = settings.ttsEngine || 'aivis';
  $('cloneStyle').value = settings.cloneStyle || 'natural';
  $('qwenVoice').value = settings.qwenVoice || 'Ryan';
  $('speakerVerificationEnabled').checked = settings.speakerVerificationEnabled !== false;
  $('speakerVerificationThreshold').value = settings.speakerVerificationThreshold ?? 0.45;
  $('adaptiveEndpointEnabled').checked = settings.adaptiveEndpointEnabled !== false;
  $('speechSilenceMs').value = settings.speechSilenceMs || 650;
  $('speechMinMs').value = settings.speechMinMs || 280;
  $('vadSensitivity').value = settings.vadSensitivity || 2.4;
  if (settings.discordTokenConfigured) $('discordToken').placeholder = 'Saved securely — leave blank to keep it';
}

async function saveSettings() {
  const patch = {
    guildId: $('guildId').value.trim(),
    channelId: $('channelId').value.trim(),
    microphoneDeviceId: $('microphoneDevice')?.value || '',
    inputLanguage: $('inputLanguage').value,
    outputLanguage: $('outputLanguage').value,
    englishTranslationMode: $('englishTranslationMode').value,
    whisperLanguage: $('inputLanguage').value,
    ttsEngine: $('ttsEngine').value,
    cloneStyle: $('cloneStyle').value,
    qwenVoice: $('qwenVoice').value,
    aivisSpeakerId: $('speakerId').value,
    speakerVerificationEnabled: $('speakerVerificationEnabled').checked,
    speakerVerificationThreshold: Number($('speakerVerificationThreshold').value || 0.45),
    adaptiveEndpointEnabled: $('adaptiveEndpointEnabled').checked,
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

async function saveLiveVoiceSettings() {
  const patch = {
    inputLanguage: $('inputLanguage').value,
    outputLanguage: $('outputLanguage').value,
    englishTranslationMode: $('englishTranslationMode').value,
    whisperLanguage: $('inputLanguage').value,
    ttsEngine: $('ttsEngine').value,
    cloneStyle: $('cloneStyle').value,
    qwenVoice: $('qwenVoice').value,
    aivisSpeakerId: $('speakerId').value,
    speakerVerificationEnabled: $('speakerVerificationEnabled').checked,
    speakerVerificationThreshold: Number($('speakerVerificationThreshold').value || 0.45),
    adaptiveEndpointEnabled: $('adaptiveEndpointEnabled').checked
  };
  settings = await window.voiceBridge.saveSettings(patch);

  const engineLabel = patch.ttsEngine === 'clone'
    ? 'My Voice'
    : patch.ttsEngine === 'qwen'
      ? 'Qwen multilingual — ' + patch.qwenVoice
      : 'AivisSpeech';
  log(
    'Voice route updated: ' +
    patch.inputLanguage + ' → ' +
    patch.outputLanguage + ' → ' +
    engineLabel + '.',
    'ok'
  );
}

function updateVoiceEngineUi() {
  const engine = $('ttsEngine')?.value || 'aivis';
  const qwen = $('qwenVoice')?.closest('label');
  const aivis = $('speakerId')?.closest('label');
  const clone = $('myVoiceSetup');
  if (qwen) qwen.classList.toggle('hidden', engine !== 'qwen');
  if (aivis) aivis.classList.toggle('hidden', engine !== 'aivis');
  if (clone) clone.classList.toggle('hidden', engine !== 'clone');
}

async function warmMyVoice() {
  if (!window.voiceBridge.prepareVoiceClone) return;
  try {
    await window.voiceBridge.prepareVoiceClone();
  } catch (err) {
    log('My Voice warm-up failed: ' + err.message, 'warn');
  }
}

async function refreshVoiceProfile() {
  const status = $('voiceProfileStatus');
  if (!status || !window.voiceBridge.getVoiceProfile) return;

  try {
    const profile = await window.voiceBridge.getVoiceProfile();
    if (profile?.configured) {
      status.textContent = 'My Voice saved';
      status.className = 'badge on';
      if ($('voiceReferenceText') && !$('voiceReferenceText').value) {
        $('voiceReferenceText').value = profile.refText || '';
      }
    } else if (profile?.hasAudio) {
      status.textContent = 'Recording selected — add transcript';
      status.className = 'badge off';
    } else {
      status.textContent = 'No personal voice saved';
      status.className = 'badge off';
    }
  } catch (err) {
    status.textContent = 'Voice profile unavailable';
    status.className = 'badge off';
    log('Could not load My Voice profile: ' + err.message, 'warn');
  }
}

async function refreshMicrophones({ requestPermission = false } = {}) {
  if (requestPermission) {
    const granted = await window.voiceBridge.requestMicrophone();
    if (!granted) throw new Error('Microphone permission was not granted.');
  }

  const select = $('microphoneDevice');
  if (!select) return [];

  const preferred = select.value || settings.microphoneDeviceId || '';
  const devices = (await navigator.mediaDevices.enumerateDevices())
    .filter((device) => device.kind === 'audioinput');

  select.innerHTML = '<option value="">System default</option>';
  devices.forEach((device, index) => {
    const option = document.createElement('option');
    option.value = device.deviceId;
    option.textContent = device.label || ('Microphone ' + (index + 1));
    select.appendChild(option);
  });

  if (preferred && devices.some((d) => d.deviceId === preferred)) {
    select.value = preferred;
  }

  return devices;
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
  onsetHotMs = 0;
  voicedMs = 0;
  utteranceNoiseFloor = noiseFloor;
  hesitationCount = 0;
  longestPauseMs = 0;
  bargeInAttempted = false;
  bargeInPromise = null;
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
  const actualVoicedMs = voicedMs;
  const avgRms = rmsFrames ? sumRms / rmsFrames : 0;
  const peak = peakRms;
  const baseline = Math.max(0.0001, utteranceNoiseFloor);
  const snrDb = 20 * Math.log10(Math.max(avgRms, 0.0001) / baseline);
  const voicedRatio = durationMs > 0 ? actualVoicedMs / durationMs : 0;
  const pendingBargeIn = bargeInPromise;
  resetUtterance();

  const minimum = Number(settings.speechMinMs || 280);
  const minimumVoiced = Math.max(180, Math.min(320, minimum * 0.65));

  if (
    durationMs < minimum ||
    actualVoicedMs < minimumVoiced ||
    voicedRatio < 0.22 ||
    snrDb < 5.5 ||
    muted
  ) {
    if (!muted) {
      log(
        'Ignored weak/non-speech trigger (' +
        Math.round(actualVoicedMs) + ' ms voiced, ' +
        Math.round(voicedRatio * 100) + '% voiced, ' +
        snrDb.toFixed(1) + ' dB SNR).',
        'info'
      );
    }
    return;
  }

  const pcm = flatten(utteranceChunks);
  const wav = encodeWav(pcm, captureSampleRate || 48000);
  try {
    // If this utterance triggered barge-in, let that verification finish
    // before submitting the utterance. Otherwise the successful barge-in can
    // advance the turn epoch after this request has already been tagged,
    // accidentally making the new sentence stale.
    if (pendingBargeIn) {
      try { await pendingBargeIn; } catch {}
    }

    await window.voiceBridge.processUtterance(wav, {
      durationMs,
      voicedMs: actualVoicedMs,
      voicedRatio,
      snrDb,
      avgRms,
      peakRms: peak
    });
  } catch (err) {
    log(err.message, 'error');
  }
}

async function maybeBargeIn() {
  if (
    bargeInAttempted ||
    !speechActive ||
    voicedMs < 550 ||
    !window.voiceBridge.bargeIn
  ) {
    return;
  }

  bargeInAttempted = true;

  bargeInPromise = (async () => {
    try {
      const pcm = flatten(chunks);
      if (!pcm.length) return { interrupted: false, reason: 'no-audio' };
      const wav = encodeWav(pcm, captureSampleRate || 48000);
      const result = await window.voiceBridge.bargeIn(wav);

      if (result?.interrupted) {
        log('Barge-in accepted — current VoiceBridge speech stopped.', 'ok');
      }
      return result;
    } catch (err) {
      log('Barge-in check failed: ' + err.message, 'warn');
      return { interrupted: false, reason: 'error' };
    }
  })();

  return bargeInPromise;
}

function adaptiveSilenceTargetMs() {
  const configuredMax = Math.max(
    350,
    Math.min(2000, Number(settings.speechSilenceMs || 650))
  );

  if (settings.adaptiveEndpointEnabled === false) return configuredMax;

  const voicedSeconds = Math.max(0, voicedMs / 1000);

  // Fast for short, decisive replies; gradually more tolerant as a turn grows.
  let target = 330 + Math.min(150, voicedSeconds * 32);

  // If the user already paused and resumed, treat them as being in a more
  // hesitant / thoughtful cadence and allow extra room for the next pause.
  target += Math.min(220, hesitationCount * 110);

  // A previously long recovered pause is strong evidence that this speaker
  // naturally pauses mid-thought, so bias upward a little more.
  if (longestPauseMs >= 260) target += 70;

  return Math.min(configuredMax, Math.max(300, Math.round(target)));
}

function handlePcm(samples, sampleRate = captureSampleRate || 48000) {
  if (!listening) return;

  captureSampleRate = sampleRate || captureSampleRate || 48000;
  pcmFramesSeen += 1;

  if (pcmFramesSeen === 1) {
    log(`Microphone PCM is flowing at ${captureSampleRate} Hz via ${capturePath}.`, 'ok');
    if (muted) {
      log('Microphone audio is arriving, but VoiceBridge is currently muted. Unmute VoiceBridge to process speech.', 'warn');
    }
  }

  if (muted) return;

  processedFramesSeen += 1;
  const frameMs = (samples.length / captureSampleRate) * 1000;
  const rms = rmsOf(samples);
  $('meterFill').style.width = `${Math.min(100, rms * 1200)}%`;

  const sensitivity = Number(settings.vadSensitivity || 2.4);
  const threshold = Math.max(0.0025, noiseFloor * sensitivity);
  const hot = rms > threshold;

  if (!speechActive && !hot) noiseFloor = noiseFloor * 0.995 + rms * 0.005;

  const maxPreRollFrames = Math.ceil((captureSampleRate * 0.22) / samples.length);
  preRoll.push(samples);
  if (preRoll.length > maxPreRollFrames) preRoll.shift();

  if (!speechActive) {
    if (hot) {
      hotFrames += 1;
      onsetHotMs += frameMs;
    } else {
      hotFrames = 0;
      onsetHotMs = Math.max(0, onsetHotMs - frameMs * 2);
    }

    // Require a real onset rather than two individual hot frames. This rejects
    // keyboard taps, desk bumps, breaths, and other impulse noise before Whisper.
    if (onsetHotMs >= 90) {
      speechActive = true;
      chunks = preRoll.slice();
      speechMs = onsetHotMs;
      voicedMs = onsetHotMs;
      utteranceNoiseFloor = Math.max(0.0001, noiseFloor);
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

  if (hot) {
    voicedMs += frameMs;
    if (voicedMs >= 550 && !bargeInAttempted) {
      maybeBargeIn();
    }
  }

  if (rms < threshold * 0.7) {
    silenceMs += frameMs;
    longestPauseMs = Math.max(longestPauseMs, silenceMs);
  } else {
    // A recovered pause of ~220 ms+ is likely a real hesitation rather than
    // frame-level VAD flutter. Remember it so the next pause gets more room.
    if (silenceMs >= 220) hesitationCount += 1;
    silenceMs = 0;
  }

  const endpointMs = adaptiveSilenceTargetMs();
  if (silenceMs >= endpointMs || speechMs >= Number(settings.speechMaxMs || 12000)) {
    if (settings.adaptiveEndpointEnabled !== false) {
      log(
        'Adaptive endpoint: ' +
        Math.round(endpointMs) + ' ms pause' +
        (hesitationCount ? ' after ' + hesitationCount + ' resumed pause' + (hesitationCount === 1 ? '' : 's') : '') +
        '.',
        'info'
      );
    }
    finalizeUtterance();
  }
}

async function startDirectTrackCapture(track) {
  if (!('MediaStreamTrackProcessor' in window)) return false;

  try {
    trackProcessor = new MediaStreamTrackProcessor({ track });
    trackReader = trackProcessor.readable.getReader();
  } catch (err) {
    trackProcessor = null;
    trackReader = null;
    log('Direct track capture unavailable: ' + err.message + '. Falling back to AudioWorklet.', 'warn');
    return false;
  }

  capturePath = 'MediaStreamTrackProcessor';
  trackProcessorTask = (async () => {
    try {
      while (listening && trackReader) {
        const { value: frame, done } = await trackReader.read();
        if (done || !frame) break;

        try {
          const channels = Math.max(1, Number(frame.numberOfChannels || 1));
          const frames = Number(frame.numberOfFrames || 0);
          if (!frames) continue;

          const mono = new Float32Array(frames);
          for (let channelIndex = 0; channelIndex < channels; channelIndex++) {
            const plane = new Float32Array(frames);
            frame.copyTo(plane, {
              planeIndex: channelIndex,
              format: 'f32-planar'
            });
            for (let i = 0; i < frames; i++) {
              mono[i] += plane[i] / channels;
            }
          }

          handlePcm(mono, Number(frame.sampleRate || captureSampleRate || 48000));
        } finally {
          try { frame.close(); } catch {}
        }
      }
    } catch (err) {
      if (listening) log('Direct microphone frame reader failed: ' + err.message, 'error');
    }
  })();

  log('Using direct MediaStreamTrackProcessor capture (WebAudio bypassed).', 'ok');
  return true;
}

async function startListening() {
  if (listening) return;

  const granted = await window.voiceBridge.requestMicrophone();
  if (!granted) throw new Error('Microphone permission was not granted.');

  await refreshMicrophones().catch(() => {});
  const selectedDeviceId = $('microphoneDevice')?.value || settings.microphoneDeviceId || '';

  const audioConstraints = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false
  };
  if (selectedDeviceId) audioConstraints.deviceId = { exact: selectedDeviceId };

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: audioConstraints,
      video: false
    });
  } catch (err) {
    if (selectedDeviceId && (err?.name === 'OverconstrainedError' || err?.name === 'NotFoundError')) {
      log('Saved microphone is unavailable; retrying with the system default input.', 'warn');
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        },
        video: false
      });
    } else {
      throw err;
    }
  }

  const track = mediaStream.getAudioTracks()[0];
  if (!track) throw new Error('macOS returned a microphone stream with no audio track.');
  try { track.contentHint = 'speech'; } catch {}

  track.addEventListener('mute', () => log('Microphone track became muted by the OS/device.', 'warn'));
  track.addEventListener('unmute', () => log('Microphone track resumed.', 'ok'));
  track.addEventListener('ended', () => log('Microphone track ended.', 'error'));

  const trackSettings = track.getSettings?.() || {};
  captureSampleRate = Number(trackSettings.sampleRate || 48000);
  capturePath = 'starting';
  pcmFramesSeen = 0;
  processedFramesSeen = 0;
  listening = true;

  const directStarted = await startDirectTrackCapture(track);

  if (!directStarted) {
    capturePath = 'AudioWorklet';
    const contextOptions = { latencyHint: 'interactive' };
    if (Number(trackSettings.sampleRate) > 0) contextOptions.sampleRate = Number(trackSettings.sampleRate);
    audioContext = new AudioContext(contextOptions);
    try { await audioContext.resume(); } catch {}

    const workletUrl = new URL('pcm-worklet.js', window.location.href).href;
    await audioContext.audioWorklet.addModule(workletUrl);

    sourceNode = audioContext.createMediaStreamSource(new MediaStream([track]));
    workletNode = new AudioWorkletNode(audioContext, 'pcm-processor');
    workletNode.port.onmessage = (event) => {
      const message = event.data;
      if (message?.type === 'pcm') {
        handlePcm(message.samples, audioContext.sampleRate);
        return;
      }
      if (message?.type === 'heartbeat' && listening && pcmFramesSeen === 0) {
        const s = track.getSettings?.() || {};
        log(
          'AudioWorklet is alive but has no microphone frames yet ' +
          '(track=' + track.readyState +
          ', muted=' + track.muted +
          ', channels=' + message.channels +
          ', deviceChannels=' + (s.channelCount || '?') +
          ', deviceRate=' + (s.sampleRate || '?') + ' Hz).',
          'warn'
        );
      }
    };
    sourceNode.connect(workletNode);

    silentGain = audioContext.createGain();
    silentGain.gain.value = 0;
    workletNode.connect(silentGain).connect(audioContext.destination);

    if (audioContext.state !== 'running') await audioContext.resume();
    captureSampleRate = audioContext.sampleRate;
  }

  log(
    'Mic opened: ' + (track.label || 'default input') +
    '; track=' + track.readyState +
    ', muted=' + track.muted +
    ', deviceRate=' + (trackSettings.sampleRate || '?') + ' Hz' +
    ', deviceChannels=' + (trackSettings.channelCount || '?') +
    ', capture=' + capturePath + '.',
    'info'
  );

  setTimeout(() => {
    if (listening && pcmFramesSeen === 0) {
      const extra = capturePath === 'MediaStreamTrackProcessor' && trackProcessor
        ? ', processorTotalFrames=' + (trackProcessor.totalFrames ?? '?') +
          ', processorDiscardedFrames=' + (trackProcessor.discardedFrames ?? '?')
        : '';
      log(
        'No raw microphone PCM reached VoiceBridge after 1.5 s ' +
        '(capture=' + capturePath +
        ', track=' + track.readyState +
        ', trackMuted=' + track.muted +
        ', appMuted=' + muted + extra + ').',
        'error'
      );
    } else if (listening && pcmFramesSeen > 0 && processedFramesSeen === 0 && muted) {
      log(
        'Raw microphone PCM is healthy (' + pcmFramesSeen +
        ' frames seen), but VoiceBridge is muted. Unmute the app to enable speech detection.',
        'warn'
      );
    }
  }, 1500);

  $('listenButton').textContent = 'Stop listening';
  updateListeningBadge();
  log('Always-listening microphone capture started locally.', 'ok');
}

async function stopListening() {
  listening = false;
  resetUtterance();

  const reader = trackReader;
  trackReader = null;
  try { await reader?.cancel(); } catch {}
  trackProcessor = null;
  trackProcessorTask = null;

  try { sourceNode?.disconnect(); } catch {}
  try { workletNode?.disconnect(); } catch {}
  try { silentGain?.disconnect(); } catch {}
  try { mediaStream?.getTracks().forEach((t) => t.stop()); } catch {}
  try { await audioContext?.close(); } catch {}

  sourceNode = null;
  workletNode = null;
  silentGain = null;
  mediaStream = null;
  audioContext = null;
  capturePath = 'none';
  captureSampleRate = 48000;
  pcmFramesSeen = 0;
  processedFramesSeen = 0;

  $('listenButton').textContent = 'Start always listening';
  updateListeningBadge();
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
$('refreshMicrophones')?.addEventListener('click', async () => {
  try {
    const devices = await refreshMicrophones({ requestPermission: true });
    log('Found ' + devices.length + ' microphone input' + (devices.length === 1 ? '' : 's') + '.', 'ok');
  } catch (err) {
    log('Microphone refresh failed: ' + err.message, 'error');
  }
});

$('microphoneDevice')?.addEventListener('change', async () => {
  const microphoneDeviceId = $('microphoneDevice').value || '';
  settings = await window.voiceBridge.saveSettings({ microphoneDeviceId });
  const label = $('microphoneDevice').selectedOptions?.[0]?.textContent || 'System default';
  log('Microphone selected: ' + label + '. Restart listening to apply the change.', 'ok');
});

$('voiceReferenceText')?.addEventListener('change', async () => {
  const refText = $('voiceReferenceText').value.trim();
  if (!refText) return;

  try {
    const profile = await window.voiceBridge.saveVoiceProfileTranscript(refText);
    if (profile?.configured) {
      $('voiceProfileStatus').textContent = 'My Voice saved';
      $('voiceProfileStatus').className = 'badge on';
      $('ttsEngine').value = 'clone';
      updateVoiceEngineUi();
      await saveLiveVoiceSettings();
      await warmMyVoice();
      log('Personal voice reference is ready.', 'ok');
    }
  } catch (err) {
    // This is normal if the user types a transcript before selecting audio.
    if (!String(err.message || '').includes('Choose a reference recording first')) {
      log('Could not save voice transcript: ' + err.message, 'error');
    }
  }
});

$('chooseVoiceSample')?.addEventListener('click', async () => {
  const refText = $('voiceReferenceText')?.value?.trim() || '';

  try {
    const profile = await window.voiceBridge.importVoiceProfile(refText);
    if (profile?.canceled) return;

    if (profile?.configured) {
      $('voiceProfileStatus').textContent = 'My Voice saved';
      $('voiceProfileStatus').className = 'badge on';
      $('ttsEngine').value = 'clone';
      updateVoiceEngineUi();
      await saveLiveVoiceSettings();
      await warmMyVoice();
      log('Personal voice reference is ready.', 'ok');
    } else {
      $('voiceProfileStatus').textContent = 'Recording selected — add transcript';
      $('voiceProfileStatus').className = 'badge off';
      log('Reference recording selected. Enter the exact transcript to finish setup.', 'warn');
      $('voiceReferenceText')?.focus();
    }
  } catch (err) {
    log('Could not create My Voice profile: ' + err.message, 'error');
  }
});

$('ttsEngine')?.addEventListener('change', async () => {
  updateVoiceEngineUi();
  try {
    await saveLiveVoiceSettings();
    if ($('ttsEngine').value === 'clone') await warmMyVoice();
  } catch (err) {
    log('Could not save voice engine: ' + err.message, 'error');
  }
});

for (const id of ['inputLanguage', 'outputLanguage', 'englishTranslationMode', 'cloneStyle', 'qwenVoice', 'speakerId', 'speakerVerificationEnabled', 'speakerVerificationThreshold', 'adaptiveEndpointEnabled']) {
  $(id)?.addEventListener('change', async () => {
    try { await saveLiveVoiceSettings(); }
    catch (err) { log('Could not save voice route: ' + err.message, 'error'); }
  });
}

$('speechSilenceMs')?.addEventListener('change', async () => {
  try {
    const speechSilenceMs = Math.max(350, Number($('speechSilenceMs').value || 650));
    settings = await window.voiceBridge.saveSettings({ speechSilenceMs });
    log('Maximum endpoint pause set to ' + speechSilenceMs + ' ms.', 'ok');
  } catch (err) {
    log('Could not save endpoint timing: ' + err.message, 'error');
  }
});

$('saveButton').addEventListener('click', saveSettings);
$('refreshVoices').addEventListener('click', refreshVoices);
$('launchAivis').addEventListener('click', async () => {
  await window.voiceBridge.launchAivis();
  log('Asked macOS to launch AivisSpeech.');
});
$('testVoice').addEventListener('click', async () => {
  try { await saveSettings(); await window.voiceBridge.testVoice(''); }
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

navigator.mediaDevices?.addEventListener?.('devicechange', () => {
  refreshMicrophones().catch(() => {});
});

(async () => {
  await loadSettings();
  await refreshMicrophones().catch((err) => log('Could not enumerate microphones yet: ' + err.message, 'warn'));
  if ($('microphoneDevice') && settings.microphoneDeviceId) {
    $('microphoneDevice').value = settings.microphoneDeviceId;
  }
  const state = await window.voiceBridge.getState();
  updateMuteUi(state);
  updateVoiceEngineUi();
  await refreshVoiceProfile();
  if ($('ttsEngine')?.value === 'clone') warmMyVoice();
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
