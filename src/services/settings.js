const fs = require('node:fs');
const path = require('node:path');
const { app, safeStorage } = require('electron');

const defaults = {
  guildId: '',
  channelId: '',
  microphoneDeviceId: '',
  whisperLanguage: 'en',
  ttsEngine: 'aivis',
  aivisSpeakerId: '',
  speechSilenceMs: 650,
  speechMinMs: 280,
  speechMaxMs: 12000,
  vadSensitivity: 2.8
};

function filePath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function readRaw() {
  try {
    return JSON.parse(fs.readFileSync(filePath(), 'utf8'));
  } catch {
    return {};
  }
}

function decryptToken(value) {
  if (!value) return '';
  try {
    if (value.startsWith('enc:') && safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(Buffer.from(value.slice(4), 'base64'));
    }
    if (value.startsWith('plain:')) return Buffer.from(value.slice(6), 'base64').toString('utf8');
  } catch {}
  return '';
}

function encryptToken(token) {
  if (!token) return '';
  if (safeStorage.isEncryptionAvailable()) {
    return `enc:${safeStorage.encryptString(token).toString('base64')}`;
  }
  // Local-development fallback only. macOS packaged builds normally have safeStorage.
  return `plain:${Buffer.from(token, 'utf8').toString('base64')}`;
}

function loadSettings({ includeToken = false } = {}) {
  const raw = readRaw();
  const settings = { ...defaults, ...raw };
  delete settings.discordTokenEncrypted;
  delete settings.manualMuted;
  if (includeToken) settings.discordToken = decryptToken(raw.discordTokenEncrypted);
  else settings.discordTokenConfigured = !!raw.discordTokenEncrypted;
  return settings;
}

function saveSettings(patch = {}) {
  const raw = readRaw();
  const next = { ...raw };

  for (const [key, value] of Object.entries(patch)) {
    if (key === 'discordToken') continue;
    if (Object.prototype.hasOwnProperty.call(defaults, key)) next[key] = value;
  }

  if (typeof patch.discordToken === 'string' && patch.discordToken.trim()) {
    next.discordTokenEncrypted = encryptToken(patch.discordToken.trim());
  }
  if (patch.clearDiscordToken === true) delete next.discordTokenEncrypted;

  fs.mkdirSync(path.dirname(filePath()), { recursive: true });
  fs.writeFileSync(filePath(), JSON.stringify(next, null, 2), { mode: 0o600 });
  return loadSettings();
}

module.exports = { loadSettings, saveSettings };
