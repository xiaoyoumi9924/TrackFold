const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('shiyinDesktop', Object.freeze({
  confirmPlaybackStopped: () => ipcRenderer.send('shiyin:playback-stopped'),
  shutdownTimer: minutes => ipcRenderer.invoke('shiyin:shutdown-timer', minutes),
  preferences: patch => ipcRenderer.invoke('shiyin:preferences', patch),
  onAction: handler => {
    const listener = (_event, action) => handler(action);
    ipcRenderer.on('shiyin:action', listener);
    return () => ipcRenderer.removeListener('shiyin:action', listener);
  },
  openPrivacy: () => ipcRenderer.invoke('shiyin:privacy'),
}));
