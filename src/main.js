const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const {
  app,
  BrowserWindow,
  ipcMain,
  systemPreferences,
  shell
} = require('electron');
const { loadSettings, saveSettings } = require('./services/settings');
const whisper = require('./services/whisper');
const { cleanTranscript } = require('./services/speechFilter');
const aivis = require('./services/aivis');
const discordVoice = require('./services/discordVoice');
const updater = require('./services/updater');

let win = null;
let helper = null;
let helperMuted = false;
let manualMuted = false;
let whisperReady = false;
let processing = Promise.resolve();

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
    const wav = await aivis.synthesize(String(text || 'VoiceBridge is ready.'), settings.aivisSpeakerId, {});
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
      status('Transcribing locally…', 'busy');
      const rawText = await whisper.transcribe(wavBytes, settings.whisperLanguage || 'en');
      const filtered = cleanTranscript(rawText);
      if (filtered.removed.length) {
        status(`Ignored non-speech: ${filtered.removed.join(', ')}`, 'info');
      }
      const text = filtered.text;
      if (!text || text === '[BLANK_AUDIO]') return { text: '', skipped: 'empty' };
      status(`You: ${text}`, 'transcript');

      const tts = await aivis.synthesize(text, settings.aivisSpeakerId, prosody || {});
      if (!discordVoice.isConnected()) {
        status('Synthesized speech is ready, but Discord is not connected.', 'warn');
        return { text, spoken: false };
      }
      discordVoice.enqueue(tts);
      status('Synthetic voice queued to Discord.', 'ok');
      return { text, spoken: true };
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
  discordVoice.disconnect();
});
