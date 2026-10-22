const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hexigridDesktop', Object.freeze({
  chooseBackupDirectory: () => ipcRenderer.invoke('hexigrid:choose-backup-directory')
}));
