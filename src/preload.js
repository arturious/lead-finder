const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("leadfinder", {
  bootstrap: () => ipcRenderer.invoke("bootstrap"),
  leadsFor: (country) => ipcRenderer.invoke("leads-for", country),
  start: (payload) => ipcRenderer.invoke("start", payload),
  stop: () => ipcRenderer.invoke("stop"),
  showBrowser: () => ipcRenderer.invoke("show-browser"),
  saveProxy: (value) => ipcRenderer.invoke("save-proxy", value),
  checkProxy: (value) => ipcRenderer.invoke("check-proxy", value),
  exportFile: (kind) => ipcRenderer.invoke("export", kind),
  clearLeads: () => ipcRenderer.invoke("clear-leads"),
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
