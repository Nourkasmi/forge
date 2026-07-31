const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('forge', {
  info: () => ipcRenderer.invoke('app:info'),
  commonPaths: () => ipcRenderer.invoke('app:commonPaths'),
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  listFolder: (p) => ipcRenderer.invoke('fs:listFolder', p),
  parentFolder: (p) => ipcRenderer.invoke('fs:parent', p),
  openPath: (fullPath) => ipcRenderer.invoke('shell:openPath', fullPath),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  setupStatus: () => ipcRenderer.invoke('setup:status'),
  setupInstall: () => ipcRenderer.invoke('setup:install'),
  setupLogin: () => ipcRenderer.invoke('setup:login'),
  setupCancel: () => ipcRenderer.invoke('setup:cancel'),
  setupRevealLog: () => ipcRenderer.invoke('setup:revealLog'),
  chatRevealLog: () => ipcRenderer.invoke('chat:revealLog'),
  onSetupProgress: (cb) => ipcRenderer.on('setup:progress', (_e, data) => cb(data)),
  startClaude: (cwd, prompt, resumeSessionId) => ipcRenderer.invoke('claude:start', { cwd, prompt, resumeSessionId }),
  stopClaude: (sessionId) => ipcRenderer.invoke('claude:stop', { sessionId }),
  onEvent: (cb) => ipcRenderer.on('claude:event', (_e, data) => cb(data)),
  onStderr: (cb) => ipcRenderer.on('claude:stderr', (_e, data) => cb(data)),
  onClosed: (cb) => ipcRenderer.on('claude:closed', (_e, data) => cb(data)),
  onError: (cb) => ipcRenderer.on('claude:error', (_e, data) => cb(data)),
});
