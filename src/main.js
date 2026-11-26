const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { checkForUpdate, downloadFile, updateScript } = require("./update");
const { COUNTRIES } = require("./countries");
const { listSources } = require("./sources");
const { createStore } = require("./store");
const { createEngine } = require("./engine");
const { leadsToCsv, leadsToXlsx } = require("./export");
const { checkExitIp } = require("./proxy");

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
    minExperience: store.data.minExperience || "",
    leads: store.leadsFor(store.data.lastCountry || ""),
    status: engine.snapshot(),
    proxy: store.data.proxy || "",
    version: app.getVersion()
  }));

  ipcMain.handle("check-update", () => checkForUpdate(app.getVersion()));

  ipcMain.handle("install-update", async () => {
    if (process.platform !== "darwin" || !app.isPackaged) {
      return { ok: false, error: "Обновление ставится из собранного приложения на macOS" };
    }
    const info = await checkForUpdate(app.getVersion());
    if (!info.ok || !info.update || !info.url) {
      return { ok: false, error: info.error || "Обновления нет" };
    }
    const dmg = path.join(app.getPath("temp"), "Lead-Finder-update.dmg");
    try {
      await downloadFile(info.url, dmg);
    } catch {
      return { ok: false, error: "Не удалось скачать DMG" };
    }
    const bundle = path.resolve(process.execPath, "..", "..", "..");
    const script = path.join(app.getPath("temp"), "lead-finder-update.sh");
    fs.writeFileSync(script, updateScript({ pid: process.pid, dmg, bundle }), { mode: 0o755 });
    spawn("bash", [script], { detached: true, stdio: "ignore" }).unref();
    setImmediate(() => app.quit());
    return { ok: true };
  });

  ipcMain.handle("leads-for", (_event, country) => {
    if (country) store.setLast(store.data.lastSite || "myfxbook", country);
    return store.leadsFor(country);
  });

  ipcMain.handle("start", async (_event, payload) => {
    const body = payload || {};
    if (Object.prototype.hasOwnProperty.call(body, "proxy")) await engine.useProxy(body.proxy);
    if (Object.prototype.hasOwnProperty.call(body, "minExperience")) store.setMinExperience(body.minExperience);
    return engine.start(body);
  });

  ipcMain.handle("save-experience", (_event, value) => {
    store.setMinExperience(value);
    return store.data.minExperience || "";
  });

  ipcMain.handle("save-proxy", (_event, value) => engine.useProxy(value));

  ipcMain.handle("check-proxy", async (_event, value) => {
    await engine.useProxy(value);
    try {
      const ip = await checkExitIp(value);
      return { ok: true, message: `Прокси работает. Внешний IP: ${ip}` };
    } catch (error) {
      return { ok: false, message: error && error.message ? error.message : "Прокси недоступен" };
    }
  });

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

  ipcMain.handle("reset-memory", async () => {
    if (engine.snapshot().running) return { ok: false, busy: true };
    const answer = await dialog.showMessageBox(mainWindow, {
      type: "question",
      buttons: ["Сбросить", "Отмена"],
      defaultId: 1,
      cancelId: 1,
      message: "Поиск начнётся с начала. Найденные лиды останутся."
    });
    if (answer.response !== 0) return { ok: false, canceled: true };
    if (engine.snapshot().running) return { ok: false, busy: true };
    store.clearMemory();
    return { ok: true };
  });

  ipcMain.handle("clear-leads", async () => {
    if (engine.snapshot().running) return { ok: false, busy: true };
    const answer = await dialog.showMessageBox(mainWindow, {
      type: "question",
      buttons: ["Удалить", "Отмена"],
      defaultId: 1,
      cancelId: 1,
      message: "Удалить всех найденных лидов?"
    });
    if (answer.response !== 0) return { ok: false, canceled: true };
    if (engine.snapshot().running) return { ok: false, busy: true };
    store.clearFound();
    send("leads", []);
    return { ok: true };
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
  engine.warm();
});

let quitting = false;
function quitApp() {
  if (quitting) return;
  quitting = true;
  const closing = engine ? engine.shutdown() : Promise.resolve();
  closing.finally(() => app.quit());
}

app.on("window-all-closed", quitApp);
app.on("before-quit", (event) => {
  if (quitting) return;
  event.preventDefault();
  quitApp();
});
