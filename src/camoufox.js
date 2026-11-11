const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ENGINES = new Set(["camoufox", "window", "impit"]);
const CAMOUFOX_MAX_SLOTS = 2;

function camoufoxSlots(slots) {
  const n = Math.floor(Number(slots));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(CAMOUFOX_MAX_SLOTS, n);
}

function normalizeHttpEngine(value) {
  return ENGINES.has(value) ? value : "camoufox";
}

function engineMode(engine) {
  if (engine === "impit") return "http";
  if (engine === "window") return "window";
  return "camoufox";
}

function fallbackEngine(requested, startError) {
  if (requested === "camoufox" && startError) return "window";
  return requested;
}

function parseSidecarLine(line) {
  const text = String(line || "").trim();
  if (!text) return null;
  const msg = JSON.parse(text);
  if (!msg || typeof msg !== "object") return null;
  if (Object.prototype.hasOwnProperty.call(msg, "ready")) {
    return { type: "ready", ready: Boolean(msg.ready), error: msg.error || "" };
  }
  if (msg.id == null) return null;
  return {
    type: "response",
    id: msg.id,
    status: Number(msg.status) || 0,
    html: msg.html || "",
    finalUrl: msg.finalUrl || "",
    ms: Number(msg.ms) || 0,
    challenge: Boolean(msg.challenge),
    error: msg.error || ""
  };
}

function toFetchResult(msg) {
  const ms = msg.ms || 0;
  if (msg.error && !msg.html) return { timeout: true, error: msg.error, status: msg.status || 0, ms };
  const result = { status: msg.status, text: msg.html || "", retryAfter: "", ms };
  if (msg.challenge) return { ...result, challenge: true };
  if (msg.status === 403 || msg.status === 429 || msg.status === 408 || msg.status >= 500) {
    return { ...result, blocked: true };
  }
  return result;
}

function venvPython(root) {
  const bin = process.platform === "win32"
    ? path.join(root, ".venv-camoufox", "Scripts", "python.exe")
    : path.join(root, ".venv-camoufox", "bin", "python");
  return fs.existsSync(bin) ? bin : "";
}

function locateCamoufox(root) {
  const python = venvPython(root);
  const script = path.join(root, "sidecar", "camoufox_server.py");
  if (!python) return { error: "no .venv-camoufox python (run npm run setup:camoufox)" };
  if (!fs.existsSync(script)) return { error: "sidecar/camoufox_server.py is missing" };
  return { python, script };
}

function killTree(child, signal) {
  if (!child || !child.pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* already gone */ }
  }
}

function createCamoufoxClient({ command, args, profileDir, proxy, log }) {
  let child = null;
  let starting = null;
  let opened = false;
  let epoch = 0;
  let proxyValue = String(proxy || "");
  let buf = "";
  let seq = 0;
  const pending = new Map();
  let readyWait = null;
  const epochWaits = new Set();

  function note(line) {
    if (typeof log === "function" && line) log(line);
  }

  function failAll(error) {
    for (const item of pending.values()) item.reject(error);
    pending.clear();
  }

  function onLine(line) {
    let msg;
    try {
      msg = parseSidecarLine(line);
    } catch {
      return;
    }
    if (!msg) return;
    if (msg.type === "ready") {
      if (readyWait) readyWait(msg);
      return;
    }
    const item = pending.get(msg.id);
    if (!item) return;
    pending.delete(msg.id);
    item.resolve(msg);
  }

  function consume(chunk) {
    buf += chunk.toString("utf8");
    let idx = buf.indexOf("\n");
    while (idx >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      onLine(line);
      idx = buf.indexOf("\n");
    }
  }

  function start() {
    if (opened && child && child.exitCode == null && child.signalCode == null) return Promise.resolve();
    if (starting) return starting;
    starting = new Promise((resolve, reject) => {
      buf = "";
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        readyWait = null;
        starting = null;
        if (error) reject(error);
        else resolve();
      };
      readyWait = (msg) => {
        if (msg.ready) {
          opened = true;
          finish();
        } else {
          opened = false;
          finish(Object.assign(new Error(msg.error || "camoufox failed to start"), { code: "CAMOUFOX_START" }));
        }
      };
      const timer = setTimeout(() => {
        finish(Object.assign(new Error("camoufox did not start"), { code: "CAMOUFOX_START" }));
      }, 90000);
      const env = {
        ...process.env,
        PYTHONUNBUFFERED: "1",
        LEADFINDER_PROXY: proxyValue,
        LEADFINDER_PROFILE: profileDir || ""
      };
      const spawned = spawn(command, args, {
        env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32"
      });
      child = spawned;
      spawned.stdout.on("data", consume);
      spawned.stderr.on("data", (chunk) => note(chunk.toString("utf8").trim()));
      spawned.on("error", (error) => {
        error.code = error.code || "CAMOUFOX_START";
        finish(error);
      });
      spawned.on("exit", (code) => {
        const error = new Error(`camoufox exited (${code})`);
        error.code = "CAMOUFOX_EXIT";
        opened = false;
        if (child === spawned) {
          failAll(error);
          child = null;
          finish(error);
        }
      });
    });
    return starting;
  }

  function stoppedError() {
    const error = new Error("stopped");
    error.code = "STOP";
    return error;
  }

  function epochMoved(ticket) {
    if (ticket !== epoch) return { promise: Promise.resolve(), drop() {} };
    let wake;
    const promise = new Promise((resolve) => {
      wake = () => {
        epochWaits.delete(wake);
        resolve();
      };
      epochWaits.add(wake);
    });
    return {
      promise,
      drop() {
        if (wake) epochWaits.delete(wake);
      }
    };
  }

  async function fetch(url, options = {}) {
    const ticket = epoch;
    const starting = start();
    starting.catch(() => {});
    const moved = epochMoved(ticket);
    try {
      await Promise.race([starting, moved.promise]);
    } finally {
      moved.drop();
    }
    if (ticket !== epoch) throw stoppedError();
    if (!child || !child.stdin.writable) {
      const error = new Error("camoufox is not running");
      error.code = "CAMOUFOX_EXIT";
      throw error;
    }
    const id = ++seq;
    const msg = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Object.assign(new Error("camoufox timeout"), { code: "CAMOUFOX_TIMEOUT" }));
      }, 100000);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });
      child.stdin.write(`${JSON.stringify({ id, url, xhr: Boolean(options && options.xhr) })}\n`);
    });
    return toFetchResult(msg);
  }

  function cancel() {
    epoch += 1;
    failAll(stoppedError());
    for (const wake of [...epochWaits]) wake();
    try {
      if (child && child.stdin.writable) child.stdin.write(`${JSON.stringify({ cmd: "stop" })}\n`);
    } catch { /* the process is already gone */ }
  }

  async function useProxy(next) {
    const value = String(next || "");
    if (value === proxyValue && child) return;
    proxyValue = value;
    if (child) await close();
  }

  function close() {
    const current = child;
    child = null;
    opened = false;
    starting = null;
    readyWait = null;
    if (!current) return Promise.resolve();
    const error = new Error("camoufox closed");
    error.code = "CAMOUFOX_CLOSED";
    failAll(error);
    return new Promise((resolve) => {
      const kill = setTimeout(() => killTree(current, "SIGKILL"), 4000);
      const term = setTimeout(() => killTree(current, "SIGTERM"), 1500);
      current.once("exit", () => {
        clearTimeout(kill);
        clearTimeout(term);
        resolve();
      });
      try {
        if (current.stdin.writable) current.stdin.write(`${JSON.stringify({ cmd: "quit" })}\n`);
      } catch { /* the process is already gone */ }
    });
  }

  return { start, fetch, useProxy, cancel, close };
}

module.exports = {
  normalizeHttpEngine,
  engineMode,
  fallbackEngine,
  camoufoxSlots,
  CAMOUFOX_MAX_SLOTS,
  parseSidecarLine,
  toFetchResult,
  locateCamoufox,
  createCamoufoxClient
};
