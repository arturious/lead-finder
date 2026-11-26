const net = require("net");
const tls = require("tls");
const { SocksClient } = require("socks");

const UNREACHABLE = "Прокси недоступен. Проверьте адрес, порт и логин.";

function decodePart(value) {
  try { return decodeURIComponent(value || ""); } catch { return value || ""; }
}

function parseProxy(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  let url;
  try { url = new URL(text); } catch { url = null; }
  const protocol = url ? url.protocol.replace(":", "").toLowerCase() : "";
  const socks = protocol === "socks5" || protocol === "socks5h";
  const http = protocol === "http" || protocol === "https";
  if (!url || (!socks && !http) || !url.hostname || !url.port) {
    throw new Error("Прокси укажите как socks5://host:port или http://host:port");
  }
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Прокси укажите как socks5://host:port или http://host:port");
  }
  return {
    protocol: socks ? "socks5" : protocol,
    host: url.hostname,
    port,
    username: decodePart(url.username),
    password: decodePart(url.password)
  };
}

function unreachable() {
  const error = new Error(UNREACHABLE);
  error.code = "PROXY";
  return error;
}

function hostPort(host, port) {
  return `${host.includes(":") ? `[${host}]` : host}:${port}`;
}

function connectHttpProxy(parsed, host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(parsed.port, parsed.host);
    const fail = () => {
      socket.destroy();
      reject(unreachable());
    };
    socket.setTimeout(12000, fail);
    socket.once("error", fail);
    socket.once("connect", () => {
      let auth = "";
      if (parsed.username) {
        const token = Buffer.from(`${parsed.username}:${parsed.password}`).toString("base64");
        auth = `Proxy-Authorization: Basic ${token}\r\n`;
      }
      socket.write(`CONNECT ${hostPort(host, port)} HTTP/1.1\r\nHost: ${hostPort(host, port)}\r\n${auth}\r\n`);
      let buf = Buffer.alloc(0);
      const onData = (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        const end = buf.indexOf("\r\n\r\n");
        if (end < 0) {
          if (buf.length > 16384) fail();
          return;
        }
        socket.off("data", onData);
        const head = buf.slice(0, end).toString("utf8");
        if (!/^HTTP\/1\.[01] 200/.test(head)) {
          fail();
          return;
        }
        const rest = buf.slice(end + 4);
        socket.setTimeout(0);
        if (rest.length) socket.unshift(rest);
        resolve(socket);
      };
      socket.on("data", onData);
    });
  });
}

async function connectThrough(parsed, host, port) {
  if (parsed.protocol !== "socks5") return connectHttpProxy(parsed, host, port);
  try {
    const info = await SocksClient.createConnection({
      timeout: 12000,
      command: "connect",
      destination: { host, port },
      proxy: {
        host: parsed.host,
        port: parsed.port,
        type: 5,
        userId: parsed.username || undefined,
        password: parsed.password || undefined
      }
    });
    return info.socket;
  } catch {
    throw unreachable();
  }
}

function httpsGet(socket, host, requestPath) {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({ socket, servername: host }, () => {
      secure.write(`GET ${requestPath} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
    });
    const timer = setTimeout(() => {
      secure.destroy();
      reject(unreachable());
    }, 12000);
    let data = Buffer.alloc(0);
    secure.on("data", (chunk) => { data = Buffer.concat([data, chunk]); });
    secure.on("error", () => {
      clearTimeout(timer);
      reject(unreachable());
    });
    secure.on("end", () => {
      clearTimeout(timer);
      const text = data.toString("utf8");
      resolve(text.split("\r\n\r\n").slice(1).join("\r\n\r\n").trim());
    });
  });
}

async function assertProxyReachable(raw) {
  const parsed = parseProxy(raw);
  if (!parsed) return;
  const socket = await connectThrough(parsed, "example.com", 443);
  socket.destroy();
}

async function checkExitIp(raw) {
  const parsed = parseProxy(raw);
  if (!parsed) throw new Error("Укажите прокси");
  const socket = await connectThrough(parsed, "api.ipify.org", 443);
  const body = await httpsGet(socket, "api.ipify.org", "/");
  const ip = body.trim();
  if (!ip || ip.length > 80) throw new Error("Прокси ответил, но внешний IP не распознан.");
  return ip;
}

function startHttpForwarder(parsed) {
  const sockets = new Set();
  const server = net.createServer((client) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    client.on("error", () => client.destroy());
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) {
        if (buf.length > 16384) client.destroy();
        return;
      }
      client.off("data", onData);
      const head = buf.slice(0, end).toString("utf8");
      const rest = buf.slice(end + 4);
      const match = /^CONNECT\s+(\[[^\]]+\]|[^:\s]+):(\d+)/i.exec(head);
      if (!match) {
        client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
        return;
      }
      const destHost = match[1].replace(/^\[|\]$/g, "");
      connectThrough(parsed, destHost, Number(match[2])).then((remote) => {
        sockets.add(remote);
        remote.on("close", () => sockets.delete(remote));
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (rest.length) remote.write(rest);
        client.pipe(remote);
        remote.pipe(client);
        remote.on("error", () => client.destroy());
        client.on("error", () => remote.destroy());
      }).catch(() => {
        client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      });
    };
    client.on("data", onData);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        server: `http://127.0.0.1:${port}`,
        close() {
          for (const socket of sockets) socket.destroy();
          return new Promise((done) => server.close(() => done()));
        }
      });
    });
  });
}

// Chromium cannot authenticate to SOCKS5. A local HTTP proxy does the login.
async function prepareChromeProxy(raw) {
  const parsed = parseProxy(raw);
  if (!parsed) return null;
  if (parsed.protocol !== "socks5") {
    const proxy = { server: `${parsed.protocol}://${hostPort(parsed.host, parsed.port)}` };
    if (parsed.username) {
      proxy.username = parsed.username;
      proxy.password = parsed.password;
    }
    return { proxy, close: async () => {} };
  }
  if (!parsed.username && !parsed.password) {
    return { proxy: { server: `socks5://${hostPort(parsed.host, parsed.port)}` }, close: async () => {} };
  }
  const forwarder = await startHttpForwarder(parsed);
  return { proxy: { server: forwarder.server }, close: forwarder.close };
}

module.exports = {
  parseProxy,
  assertProxyReachable,
  checkExitIp,
  prepareChromeProxy,
  startHttpForwarder,
  UNREACHABLE
};
