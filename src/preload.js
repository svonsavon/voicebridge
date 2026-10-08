const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('voiceBridge', {
  getState: () => ipcRenderer.invoke('app:get-state'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  requestMicrophone: () => ipcRenderer.invoke('microphone:request'),
  getVoiceProfile: () => ipcRenderer.invoke('voice:get-profile'),
  importVoiceProfile: (refText) => ipcRenderer.invoke('voice:import-reference', { refText }),
  processUtterance: (wavBytes, prosody) => ipcRenderer.invoke('speech:process', { wavBytes, prosody }),
  connectDiscord: () => ipcRenderer.invoke('discord:connect'),
  disconnectDiscord: () => ipcRenderer.invoke('discord:disconnect'),
  refreshVoices: () => ipcRenderer.invoke('tts:list-voices'),
  testVoice: (text) => ipcRenderer.invoke('tts:test', text),
  launchAivis: () => ipcRenderer.invoke('tts:launch-aivis'),
  setManualMute: (muted) => ipcRenderer.invoke('mute:set-manual', !!muted),
  getUpdateState: () => ipcRenderer.invoke('update:get-state'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  openLatestRelease: () => ipcRenderer.invoke('update:open-releases'),
  onUpdateState: (callback) => ipcRenderer.on('update-state', (_, payload) => callback(payload)),
  onStatus: (callback) => ipcRenderer.on('status', (_, payload) => callback(payload)),
  onMuteState: (callback) => ipcRenderer.on('mute-state', (_, payload) => callback(payload))
});
