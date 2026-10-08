const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const {
  app,
  BrowserWindow,
  ipcMain,
  systemPreferences,
  shell,
  dialog
} = require('electron');
const { loadSettings, saveSettings } = require('./services/settings');
const whisper = require('./services/whisper');
const { cleanTranscript } = require('./services/speechFilter');
const qwenRuntime = require('./services/qwenRuntime');
const languageRouter = require('./services/languageRouter');
const voiceProfile = require('./services/voiceProfile');
const aivis = require('./services/aivis');
const discordVoice = require('./services/discordVoice');
const updater = require('./services/updater');

let win = null;
let helper = null;
let helperMuted = false;
let manualMuted = false;
let whisperReady = false;
let processing = Promise.resolve();
let cloneWarmup = null;
let cloneWarmKey = '';

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function status(text, level = 'info') {
  console.log(`[${level}] ${text}`);
  send('status', { text, level, at: Date.now() });
}

function effectiveMuted() {
  return helperMuted || manualMuted;
}

function sendMuteState() {
  send('mute-state', {
    muted: effectiveMuted(),
    helperMuted,
    manualMuted
  });
}

function helperPath() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'hotkey-helper');
  return path.join(__dirname, '..', 'build', 'hotkey-helper');
}

function startHotkeyHelper() {
  const p = helperPath();
  if (process.platform !== 'darwin' || !fs.existsSync(p)) {
    status('Global hold-to-mute helper unavailable; the on-screen mute still works.', 'warn');
    return;
  }

  helper = spawn(p, [], { stdio: ['ignore', 'pipe', 'pipe'] });
  let carry = '';
  helper.stdout.on('data', (data) => {
    carry += data.toString();
    const lines = carry.split(/\r?\n/);
    carry = lines.pop();
    for (const line of lines) {
      if (line === 'MUTE_DOWN') helperMuted = true;
      if (line === 'MUTE_UP') helperMuted = false;
      if (line === 'READY') status('Global hold-to-mute ready: hold F8 (Fn+F8 if your top row controls media).', 'ok');
      if (line === 'PERMISSION_REQUESTED') status('macOS requested keyboard monitoring permission for the global F8 mute key.', 'warn');
      if (line === 'PERMISSION_REQUIRED') status('F8 mute needs keyboard monitoring permission. Enable VoiceBridge in System Settings → Privacy & Security → Input Monitoring, then fully quit and reopen VoiceBridge.', 'warn');
      if (line.startsWith('ERROR')) status(line, 'warn');
      sendMuteState();
    }
  });
  helper.stderr.on('data', (d) => status(`Hotkey helper: ${d.toString().trim()}`, 'warn'));
  helper.on('exit', () => {
    helperMuted = false;
    sendMuteState();
    helper = null;
  });
}

async function createWindow() {
  win = new BrowserWindow({
    width: 900,
    height: 780,
    minWidth: 760,
    minHeight: 650,
    title: 'VoiceBridge',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  await win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

async function ensureQwenReady() {
  const result = await qwenRuntime.ensureServer((line) => {
    console.log(line);
    if (line.includes('Downloading') || line.includes('Loading')) {
      status('Qwen multilingual runtime is loading…', 'busy');
    }
    if (line.includes('exited')) {
      status('Qwen runtime stopped. VoiceBridge will attempt to restart it on the next phrase.', 'warn');
    }
  });
  if (!result.ok) throw new Error(result.reason);
  return true;
}

async function warmCloneProfile({ force = false } = {}) {
  const profile = voiceProfile.getProfile();
  if (!profile.configured) {
    throw new Error('My Voice needs a reference recording and exact transcript first.');
  }

  const key = [profile.createdAt || '', profile.refText || '', profile.audioPath || ''].join('|');
  if (!force && cloneWarmKey === key && await qwenRuntime.healthy(400)) return true;
  if (cloneWarmup) return cloneWarmup;

  cloneWarmup = (async () => {
    const started = Date.now();
    status('Warming My Voice…', 'busy');
    await ensureQwenReady();
    await qwenRuntime.prepareClone({
      refAudio: profile.audioPath,
      refText: profile.refText
    });
    cloneWarmKey = key;
    status('My Voice ready in ' + ((Date.now() - started) / 1000).toFixed(1) + ' s.', 'ok');
    return true;
  })();

  try {
    return await cloneWarmup;
  } finally {
    cloneWarmup = null;
  }
}

function selectedOutputLanguage(settings) {
  return languageRouter.outputLanguageName(
    settings.outputLanguage || 'same',
    settings.inputLanguage || settings.whisperLanguage || 'en'
  );
}

async function synthesizeSelected(text, settings, prosody = {}) {
  const engine = settings.ttsEngine || 'aivis';

  if (engine === 'clone') {
    const profile = voiceProfile.getProfile();
    if (!profile.configured) {
      throw new Error('My Voice is selected, but no reference voice has been configured yet.');
    }
    await warmCloneProfile();
    const request = {
      language: selectedOutputLanguage(settings),
      refAudio: profile.audioPath,
      refText: profile.refText
    };
    try {
      return await qwenRuntime.synthesizeClone(text, request);
    } catch (err) {
      const message = String(err?.message || err || '');
      if (message.includes('RUNAWAY_AUDIO') || message.includes('UNSAFE_AUDIO')) {
        status('Blocked corrupted My Voice output before playback.', 'error');
        throw err;
      }

      status('My Voice TTS failed once; retrying local runtime…', 'warn');
      cloneWarmKey = '';
      await new Promise((resolve) => setTimeout(resolve, 300));
      await warmCloneProfile({ force: true });
      return qwenRuntime.synthesizeClone(text, request);
    }
  }

  if (engine === 'qwen') {
    await ensureQwenReady();
    return qwenRuntime.synthesize(text, {
      language: selectedOutputLanguage(settings),
      voice: settings.qwenVoice || 'Ryan'
    });
  }

  return aivis.synthesize(text, settings.aivisSpeakerId, prosody || {});
}

function registerIpc() {
  updater.registerIpc(ipcMain);
  ipcMain.handle('app:get-state', async () => ({
    whisperReady,
    discordConnected: discordVoice.isConnected(),
    muted: effectiveMuted(),
    helperMuted,
    manualMuted
  }));

  ipcMain.handle('settings:get', () => loadSettings());

  ipcMain.handle('settings:save', (_, patch) => {
    return saveSettings(patch || {});
  });

  ipcMain.handle('microphone:request', async () => {
    if (process.platform !== 'darwin') return true;
    const current = systemPreferences.getMediaAccessStatus('microphone');
    if (current === 'granted') return true;
    return systemPreferences.askForMediaAccess('microphone');
  });

  ipcMain.handle('voice:get-profile', async () => voiceProfile.getProfile());

  ipcMain.handle('voice:import-reference', async (_, { refText } = {}) => {
    const transcript = String(refText || '').trim();

    const result = await dialog.showOpenDialog(win, {
      title: 'Choose your voice reference recording',
      properties: ['openFile'],
      filters: [
        { name: 'Audio', extensions: ['wav', 'mp3', 'm4a', 'aiff', 'aif', 'flac'] }
      ]
    });

    if (result.canceled || !result.filePaths?.[0]) return { canceled: true };

    status('Preparing personal voice reference…', 'busy');
    const profile = await voiceProfile.importReference(result.filePaths[0], transcript);
    cloneWarmKey = '';

    if (profile.configured) status('My Voice reference saved locally.', 'ok');
    else status('Reference recording saved. Add its exact transcript to finish My Voice setup.', 'warn');

    return profile;
  });

  ipcMain.handle('voice:set-transcript', async (_, { refText } = {}) => {
    const profile = voiceProfile.setTranscript(refText);
    cloneWarmKey = '';
    status('My Voice transcript saved. Personal voice is ready.', 'ok');
    return profile;
  });

  ipcMain.handle('voice:prepare-clone', async () => {
    await warmCloneProfile();
    return { ok: true };
  });

  ipcMain.handle('mute:set-manual', (_, muted) => {
    manualMuted = !!muted;
    sendMuteState();
    return {
      muted: effectiveMuted(),
      helperMuted,
      manualMuted
    };
  });

  ipcMain.handle('tts:list-voices', async () => aivis.getSpeakers());
  ipcMain.handle('tts:launch-aivis', async () => aivis.launchAivis());

  ipcMain.handle('tts:test', async (_, text) => {
    const settings = loadSettings({ includeToken: true });
    const outputLanguage = selectedOutputLanguage(settings);
    const defaultTests = {
      English: 'VoiceBridge is ready.',
      Chinese: 'VoiceBridge 已经准备好了。',
      Japanese: 'VoiceBridgeの準備ができました。',
      Auto: 'VoiceBridge is ready.'
    };
    const testText = String(text || defaultTests[outputLanguage] || defaultTests.English);
    if ((settings.ttsEngine || 'aivis') === 'clone') {
      status('Test voice: My Voice clone (' + outputLanguage + ').', 'info');
    } else if ((settings.ttsEngine || 'aivis') === 'qwen') {
      status(
        'Test voice: Qwen multilingual — ' +
        (settings.qwenVoice || 'Ryan') +
        ' (' + outputLanguage + ').',
        'info'
      );
    } else {
      status('Test voice: AivisSpeech.', 'info');
    }
    const wav = await synthesizeSelected(testText, settings, {});
    if (discordVoice.isConnected()) {
      discordVoice.enqueue(wav);
      return { sentToDiscord: true };
    }
    // No Discord connection: save only synthesized audio, never microphone audio.
    const out = path.join(app.getPath('temp'), `voicebridge-test-${Date.now()}.wav`);
    fs.writeFileSync(out, wav);
    await shell.openPath(out);
    setTimeout(() => { try { fs.unlinkSync(out); } catch {} }, 60_000);
    return { sentToDiscord: false };
  });

  ipcMain.handle('discord:connect', async () => {
    const settings = loadSettings({ includeToken: true });
    const result = await discordVoice.connect({
      token: settings.discordToken,
      guildId: settings.guildId,
      channelId: settings.channelId
    }, (s) => status(s.text, s.level));
    return result;
  });

  ipcMain.handle('discord:disconnect', async () => {
    await discordVoice.disconnect();
    status('Discord disconnected.', 'info');
    return true;
  });

  ipcMain.handle('speech:process', async (_, { wavBytes, prosody }) => {
    if (effectiveMuted()) return { skipped: 'muted' };
    if (!whisperReady) return { skipped: 'whisper-not-ready' };

    // Serialize utterances so transcription/TTS preserves conversational order.
    const task = processing.then(async () => {
      if (effectiveMuted()) return { skipped: 'muted' };
      const settings = loadSettings({ includeToken: true });
      const inputLanguage = settings.inputLanguage || settings.whisperLanguage || 'en';
      const outputLanguage = settings.outputLanguage || 'same';

      const utteranceStarted = Date.now();
      const transcribeStarted = Date.now();
      status('Transcribing locally…', 'busy');
      const rawText = await whisper.transcribe(
        wavBytes,
        languageRouter.whisperLanguage(inputLanguage)
      );
      status('Transcription: ' + ((Date.now() - transcribeStarted) / 1000).toFixed(2) + ' s.', 'info');
      const filtered = cleanTranscript(rawText);
      if (filtered.removed.length) {
        status(`Ignored non-speech: ${filtered.removed.join(', ')}`, 'info');
      }

      const originalText = filtered.text;
      if (!originalText || originalText === '[BLANK_AUDIO]') {
        return { text: '', skipped: 'empty' };
      }
      status(`You: ${originalText}`, 'transcript');

      let spokenText = originalText;
      let translated = false;

      if (languageRouter.shouldTranslate(inputLanguage, outputLanguage)) {
        await ensureQwenReady();
        const request = languageRouter.translationRequest(
          originalText,
          inputLanguage,
          outputLanguage
        );
        const translationStarted = Date.now();
        status(`Translating to ${request.target}…`, 'busy');
        spokenText = await qwenRuntime.translate(
          request.text,
          request.source,
          request.target
        );
        translated = spokenText !== originalText;
        status('Translation: ' + ((Date.now() - translationStarted) / 1000).toFixed(2) + ' s.', 'info');
        status(`${request.target}: ${spokenText}`, 'translation');
      }

      if ((settings.ttsEngine || 'aivis') === 'clone') {
        status(
          'TTS engine: My Voice clone (' +
          selectedOutputLanguage(settings) +
          ').',
          'info'
        );
      } else if ((settings.ttsEngine || 'aivis') === 'qwen') {
        status(
          'TTS engine: Qwen multilingual — ' +
          (settings.qwenVoice || 'Ryan') +
          ' (' + selectedOutputLanguage(settings) + ').',
          'info'
        );
      } else {
        status('TTS engine: AivisSpeech.', 'info');
      }

      const ttsStarted = Date.now();
      const engine = settings.ttsEngine || 'aivis';

      if (engine === 'clone' && discordVoice.isConnected()) {
        const profile = voiceProfile.getProfile();
        if (!profile.configured) {
          throw new Error('My Voice is selected, but no reference voice has been configured yet.');
        }

        await warmCloneProfile();

        let firstAudioLogged = false;
        const streamed = await qwenRuntime.synthesizeCloneStream(spokenText, {
          language: selectedOutputLanguage(settings),
          refAudio: profile.audioPath,
          refText: profile.refText,
          onFirstAudio: () => {
            if (firstAudioLogged) return;
            firstAudioLogged = true;
            status(
              'TTS first audio: ' +
              ((Date.now() - ttsStarted) / 1000).toFixed(2) +
              ' s. Total to first audio: ' +
              ((Date.now() - utteranceStarted) / 1000).toFixed(2) +
              ' s.',
              'ok'
            );
          }
        });

        discordVoice.enqueuePcmStream(streamed.stream, {
          sampleRate: streamed.sampleRate,
          channels: streamed.channels
        });
        status('Streaming My Voice to Discord.', 'ok');

        try {
          await streamed.completed;
        } catch (err) {
          status('My Voice stream ended unexpectedly: ' + (err.message || String(err)), 'error');
          throw err;
        }

        status(
          'TTS stream generation: ' +
          ((Date.now() - ttsStarted) / 1000).toFixed(2) +
          ' s. Audio started before generation completed.',
          'info'
        );

        return {
          text: originalText,
          outputText: spokenText,
          translated,
          spoken: true,
          streamed: true
        };
      }

      const tts = await synthesizeSelected(spokenText, settings, prosody || {});
      status(
        'TTS: ' + ((Date.now() - ttsStarted) / 1000).toFixed(2) +
        ' s. Total after phrase end: ' + ((Date.now() - utteranceStarted) / 1000).toFixed(2) + ' s.',
        'info'
      );
      if (!discordVoice.isConnected()) {
        status('Synthesized speech is ready, but Discord is not connected.', 'warn');
        return {
          text: originalText,
          outputText: spokenText,
          translated,
          spoken: false
        };
      }

      discordVoice.enqueue(tts);
      status('Synthetic voice queued to Discord.', 'ok');
      return {
        text: originalText,
        outputText: spokenText,
        translated,
        spoken: true
      };
    });

    processing = task.catch((err) => {
      status(err.message || String(err), 'error');
    });
    return task;
  });
}

app.whenReady().then(async () => {
  registerIpc();
  manualMuted = false;
  await createWindow();
  await updater.initialize({ window: win, status });
  setTimeout(() => updater.check().catch(() => {}), 5000);
  sendMuteState();
  startHotkeyHelper();

  status('Starting local Whisper…', 'busy');
  const result = await whisper.ensureServer((line) => { console.log(line); if (line.includes('still loading')) status('Whisper is still loading its local model…', 'busy'); });
  whisperReady = !!result.ok;
  if (result.ok) status('Local Whisper ready.', 'ok');
  else status(result.reason, 'error');
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', () => {
  try { helper?.kill('SIGTERM'); } catch {}
  whisper.shutdown();
  qwenRuntime.shutdown();
  discordVoice.disconnect();
});
