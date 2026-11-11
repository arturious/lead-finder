const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const fs = require("fs");
const path = require("path");
const { COUNTRIES } = require("./countries");
const { listSources } = require("./sources");
const { createStore } = require("./store");
const { createEngine } = require("./engine");
const { leadsToCsv, leadsToXlsx } = require("./export");

// Containers often ship a broken /dev/shm. The packaged Mac app never takes this path.
if (process.platform === "linux") {
  app.commandLine.appendSwitch("no-sandbox");
  app.commandLine.appendSwitch("disable-dev-shm-usage");
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("in-process-gpu");
}

let mainWindow = null;
let engine = null;
let store = null;

function send(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(channel, payload);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 920,
    minHeight: 640,
    title: "Lead Finder",
    backgroundColor: "#f3efe6",
    icon: path.join(__dirname, "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.removeMenu();
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
}

app.whenReady().then(() => {
  const dataDir = app.getPath("userData");
  store = createStore(path.join(dataDir, "lead-finder.json"));
  engine = createEngine({
    store,
    profileDir: path.join(dataDir, "chrome-profile"),
    emit: send
  });

  ipcMain.handle("bootstrap", () => ({
    sources: listSources(),
    countries: COUNTRIES,
    lastCountry: store.data.lastCountry || "",
    lastSite: store.data.lastSite || "myfxbook",
    leads: store.leadsFor(store.data.lastCountry || ""),
    status: engine.snapshot()
  }));

  ipcMain.handle("leads-for", (_event, country) => {
    if (country) store.setLast(store.data.lastSite || "myfxbook", country);
    return store.leadsFor(country);
  });

  ipcMain.handle("start", (_event, payload) => engine.start(payload || {}));

  ipcMain.handle("stop", () => {
    engine.stop();
    return engine.snapshot();
  });

  ipcMain.handle("open-url", (_event, raw) => {
    let url;
    try { url = new URL(String(raw)); } catch { return; }
    if (url.protocol !== "https:" || !/(^|\.)myfxbook\.com$/.test(url.hostname)) return;
    shell.openExternal(url.toString());
  });

  ipcMain.handle("export", async (_event, kind) => {
    const requested = kind && typeof kind === "object" ? kind : { kind };
    kind = requested.kind;
    const country = requested.country || store.data.lastCountry || "leads";
    const leads = store.leadsFor(country);
    if (!leads.length) return { ok: false, error: "Список лидов пуст" };
    const stamp = new Date().toISOString().slice(0, 10);
    const ext = kind === "xlsx" ? "xlsx" : "csv";
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: `lead-finder-${country}-${stamp}.${ext}`,
      filters: kind === "xlsx"
        ? [{ name: "Excel", extensions: ["xlsx"] }]
        : [{ name: "CSV", extensions: ["csv"] }]
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    if (kind === "xlsx") fs.writeFileSync(result.filePath, leadsToXlsx(leads));
    else fs.writeFileSync(result.filePath, leadsToCsv(leads), "utf8");
    return { ok: true, filePath: result.filePath };
  });

  createWindow();
});

app.on("window-all-closed", () => {
  if (engine) engine.stop();
  app.quit();
});
