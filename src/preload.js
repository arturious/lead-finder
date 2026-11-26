const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("leadfinder", {
  bootstrap: () => ipcRenderer.invoke("bootstrap"),
  leadsFor: (country) => ipcRenderer.invoke("leads-for", country),
  start: (payload) => ipcRenderer.invoke("start", payload),
  stop: () => ipcRenderer.invoke("stop"),
  saveProxy: (value) => ipcRenderer.invoke("save-proxy", value),
  saveExperience: (value) => ipcRenderer.invoke("save-experience", value),
  checkProxy: (value) => ipcRenderer.invoke("check-proxy", value),
  exportFile: (kind) => ipcRenderer.invoke("export", kind),
  clearLeads: () => ipcRenderer.invoke("clear-leads"),
  resetMemory: () => ipcRenderer.invoke("reset-memory"),
  checkUpdate: () => ipcRenderer.invoke("check-update"),
  installUpdate: () => ipcRenderer.invoke("install-update"),
  openUrl: (url) => ipcRenderer.invoke("open-url", url),
  onStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on("status", listener);
    return () => ipcRenderer.removeListener("status", listener);
  },
  onLead: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("lead", listener);
    return () => ipcRenderer.removeListener("lead", listener);
  },
  onLeads: (callback) => {
    const listener = (_event, leads) => callback(leads);
    ipcRenderer.on("leads", listener);
    return () => ipcRenderer.removeListener("leads", listener);
  }
});
