const { contextBridge, ipcRenderer } = require('electron');

const listen = (channel) => (cb) => {
  const fn = (_e, data) => cb(data);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.removeListener(channel, fn);
};

contextBridge.exposeInMainWorld('sortwise', {
  info:          ()        => ipcRenderer.invoke('app:info'),
  getSettings:   ()        => ipcRenderer.invoke('settings:get'),
  setSettings:   (s)       => ipcRenderer.invoke('settings:set', s),
  pickFolder:    (opts)    => ipcRenderer.invoke('dialog:pickFolder', opts),
  scan:          (opts)    => ipcRenderer.invoke('organizer:scan', opts),
  execute:       (payload) => ipcRenderer.invoke('organizer:execute', payload),
  history:       ()        => ipcRenderer.invoke('history:list'),
  undo:          (id)      => ipcRenderer.invoke('history:undo', id),
  clearHistory:  ()        => ipcRenderer.invoke('history:clear'),
  watchState:    ()        => ipcRenderer.invoke('watch:state'),
  updateState:   ()        => ipcRenderer.invoke('update:state'),
  checkUpdates:  ()        => ipcRenderer.invoke('update:check'),
  installUpdate: ()        => ipcRenderer.invoke('update:install'),
  open:          (p)       => ipcRenderer.invoke('shell:open', p),
  reveal:        (p)       => ipcRenderer.invoke('shell:reveal', p),

  onProgress:        listen('organizer:progress'),
  onChanged:         listen('organizer:changed'),
  onNewFiles:        listen('watch:new-files'),
  onWatchState:      listen('watch:state'),
  onSettingsChanged: listen('settings:changed'),
  onHistoryChanged:  listen('history:changed'),
  onUpdateState:     listen('update:state'),
});
