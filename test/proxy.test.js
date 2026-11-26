const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const net = require("net");
const { parseProxy, startHttpForwarder, assertProxyReachable, UNREACHABLE } = require("../src/proxy");

test("proxy urls cover socks5, auth and http", () => {
  const plain = parseProxy("socks5://127.0.0.1:1080");
  assert.equal(plain.protocol, "socks5");
  assert.equal(plain.port, 1080);
  assert.equal(plain.username, "");

  const auth = parseProxy("socks5://user:p%40ss@proxy.example:9050");
  assert.equal(auth.username, "user");
  assert.equal(auth.password, "p@ss");

  const httpProxy = parseProxy("http://user:secret@10.0.0.2:8080");
  assert.equal(httpProxy.protocol, "http");
  assert.equal(httpProxy.password, "secret");
  assert.equal(parseProxy("  "), null);
  assert.throws(() => parseProxy("ftp://host:1"), /socks5:\/\/host:port/);
  assert.throws(() => parseProxy("socks5://host"), /socks5:\/\/host:port/);
});

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function startSocks5({ username, password }) {
  const server = net.createServer((socket) => {
    let stage = "greeting";
    let buf = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === "greeting") {
        if (buf.length < 2 || buf.length < 2 + buf[1]) return;
        buf = buf.slice(2 + buf[1]);
        socket.write(Buffer.from([0x05, username ? 0x02 : 0x00]));
        stage = username ? "auth" : "request";
      }
      if (stage === "auth") {
        if (buf.length < 2) return;
        const ulen = buf[1];
        if (buf.length < 2 + ulen + 1) return;
        const user = buf.slice(2, 2 + ulen).toString();
        const plen = buf[2 + ulen];
        if (buf.length < 3 + ulen + plen) return;
        const pass = buf.slice(3 + ulen, 3 + ulen + plen).toString();
        buf = buf.slice(3 + ulen + plen);
        const ok = user === username && pass === password;
        socket.write(Buffer.from([0x01, ok ? 0x00 : 0x01]));
        if (!ok) {
          socket.end();
          return;
        }
        stage = "request";
      }
      if (stage === "request") {
        if (buf.length < 4) return;
        const atyp = buf[3];
        let host;
        let offset;
        if (atyp === 1) {
          if (buf.length < 10) return;
          host = Array.from(buf.slice(4, 8)).join(".");
          offset = 8;
        } else if (atyp === 3) {
          const len = buf[4];
          if (buf.length < 5 + len + 2) return;
          host = buf.slice(5, 5 + len).toString();
          offset = 5 + len;
        } else {
          socket.end();
          return;
        }
        const port = buf.readUInt16BE(offset);
        const pending = buf.slice(offset + 2);
        stage = "relay";
        const remote = net.connect(port, host, () => {
          socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          if (pending.length) remote.write(pending);
          socket.pipe(remote);
          remote.pipe(socket);
        });
        remote.on("error", () => socket.destroy());
      }
    });
    socket.on("error", () => socket.destroy());
  });
  return listen(server).then((port) => ({ port, close: () => server.close() }));
}

function readUntil(socket, marker) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.includes(marker)) {
        socket.off("data", onData);
        resolve(buf);
      }
    };
    socket.on("data", onData);
    socket.on("error", reject);
  });
}

test("authenticated socks5 is relayed through a local http proxy", async () => {
  const web = http.createServer((req, res) => res.end("relay-ok"));
  const webPort = await listen(web);
  const socks = await startSocks5({ username: "u", password: "p@ss" });
  const forwarder = await startHttpForwarder({
    protocol: "socks5",
    host: "127.0.0.1",
    port: socks.port,
    username: "u",
    password: "p@ss"
  });
  try {
    const localPort = Number(new URL(forwarder.server).port);
    const client = net.connect(localPort, "127.0.0.1");
    client.write(`CONNECT 127.0.0.1:${webPort} HTTP/1.1\r\nHost: 127.0.0.1:${webPort}\r\n\r\n`);
    const head = await readUntil(client, Buffer.from("\r\n\r\n"));
    assert.match(head.toString("utf8"), /^HTTP\/1\.1 200/);
    client.write("GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
    const body = await readUntil(client, Buffer.from("relay-ok"));
    assert.match(body.toString("utf8"), /relay-ok/);
    client.end();
  } finally {
    await forwarder.close();
    socks.close();
    web.close();
  }
});

test("a closed proxy port is a russian error", async () => {
  await assert.rejects(
    () => assertProxyReachable("socks5://127.0.0.1:1"),
    (error) => error.message === UNREACHABLE
  );
});
