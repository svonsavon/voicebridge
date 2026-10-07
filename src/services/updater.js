const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { app, shell } = require('electron');
const { autoUpdater } = require('electron-updater');

const execFileAsync = promisify(execFile);
let mainWindow = null;
let latestInfo = null;
let developerSigned = false;
let initialized = false;
let statusSink = () => {};

function send(state) {
  const payload = {
    currentVersion: app.getVersion(),
    developerSigned,
    ...state,
  };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-state', payload);
  }
  return payload;
}

async function detectDeveloperIdSignature() {
  if (process.platform !== 'darwin' || !app.isPackaged) return false;
  // process.execPath = VoiceBridge.app/Contents/MacOS/VoiceBridge
  const appBundle = path.resolve(process.execPath, '../../..');
  try {
    const { stderr = '', stdout = '' } = await execFileAsync('/usr/bin/codesign', ['-dv', '--verbose=4', appBundle]);
    const text = `${stdout}\n${stderr}`;
    return /Authority=Developer ID Application:/i.test(text) && /TeamIdentifier=(?!not set)[A-Z0-9]+/i.test(text);
  } catch {
    return false;
  }
}

function bindEvents() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = false;

  autoUpdater.on('checking-for-update', () => send({ phase: 'checking', message: 'Checking for updates…' }));
  autoUpdater.on('update-not-available', (info) => {
    latestInfo = info || null;
    send({ phase: 'current', message: `VoiceBridge ${app.getVersion()} is up to date.` });
  });
  autoUpdater.on('update-available', (info) => {
    latestInfo = info;
    if (developerSigned) {
      send({ phase: 'available', version: info.version, message: `VoiceBridge ${info.version} is available.`, canInstall: true });
    } else {
      send({
        phase: 'available-unsigned',
        version: info.version,
        message: `VoiceBridge ${info.version} is available. Automatic installation activates after the first Developer-ID-signed build is installed.`,
        canInstall: false,
      });
    }
  });
  autoUpdater.on('download-progress', (p) => send({
    phase: 'downloading',
    version: latestInfo?.version,
    percent: Math.round(Number(p.percent || 0)),
    transferred: p.transferred,
    total: p.total,
    message: `Downloading update… ${Math.round(Number(p.percent || 0))}%`,
  }));
  autoUpdater.on('update-downloaded', (info) => send({
    phase: 'ready',
    version: info.version,
    percent: 100,
    canInstall: true,
    message: `VoiceBridge ${info.version} is ready. Restart to update.`,
  }));
  autoUpdater.on('error', (err) => {
    const message = String(err?.message || err || 'Unknown updater error');
    statusSink(`Updater: ${message}`, 'warn');
    send({ phase: 'error', message });
  });
}

async function initialize({ window, status = () => {} } = {}) {
  mainWindow = window || mainWindow;
  statusSink = status;
  if (initialized) return send({ phase: 'idle', message: 'Updater ready.' });
  developerSigned = await detectDeveloperIdSignature();
  bindEvents();
  initialized = true;
  return send({
    phase: 'idle',
    message: developerSigned
      ? 'Signed updater ready.'
      : 'Update checking ready. Automatic install waits for the first Developer-ID-signed build.',
  });
}

async function check() {
  if (!initialized) throw new Error('Updater is not initialized.');
  if (!app.isPackaged) return send({ phase: 'dev', message: 'Update checks run only in packaged builds.' });
  return autoUpdater.checkForUpdates();
}

async function download() {
  if (!developerSigned) throw new Error('Automatic installation requires a Developer-ID-signed installed build.');
  if (!latestInfo) throw new Error('Check for updates first.');
  return autoUpdater.downloadUpdate();
}

function install() {
  if (!developerSigned) throw new Error('Automatic installation requires a Developer-ID-signed installed build.');
  autoUpdater.quitAndInstall(false, true);
}

async function openReleases() {
  // Keep this URL centralized so unsigned builds have a useful fallback.
  await shell.openExternal('https://github.com/svonsavon/voicebridge/releases/latest');
  return true;
}

function registerIpc(ipcMain) {
  ipcMain.handle('update:get-state', async () => ({
    currentVersion: app.getVersion(), developerSigned, latestVersion: latestInfo?.version || null,
  }));
  ipcMain.handle('update:check', () => check());
  ipcMain.handle('update:download', () => download());
  ipcMain.handle('update:install', () => { install(); return true; });
  ipcMain.handle('update:open-releases', () => openReleases());
}

module.exports = { initialize, registerIpc, check };
