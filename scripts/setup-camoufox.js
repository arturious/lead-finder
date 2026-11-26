const { spawnSync } = require("child_process");
const path = require("path");

const root = path.join(__dirname, "..");
const venv = path.join(root, ".venv-camoufox");
const versions = ["3.12", "3.13", "3.11", "3.10"];
const python = process.platform === "win32"
  ? path.join(venv, "Scripts", "python.exe")
  : path.join(venv, "bin", "python");

function ok(cmd, args) {
  const result = spawnSync(cmd, args, { cwd: root, stdio: "inherit" });
  return result.status === 0;
}

function exists(cmd) {
  const result = spawnSync(cmd, ["--version"], { stdio: "ignore" });
  return result.status === 0;
}

let tool = "";
if (exists("uv")) {
  for (const version of versions) {
    if (ok("uv", ["venv", "--python", version, venv])) {
      tool = "uv";
      break;
    }
  }
}
if (!tool) {
  for (const version of versions) {
    const bin = process.platform === "win32" ? `python${version}.exe` : `python${version}`;
    if (!exists(bin)) continue;
    if (ok(bin, ["-m", "venv", venv])) {
      tool = "pip";
      break;
    }
  }
}
if (!tool) {
  console.error("Need Python 3.10–3.13 via uv or python3.12. Camoufox does not run on Python 3.14+.");
  process.exit(1);
}

const installed = tool === "uv"
  ? ok("uv", ["pip", "install", "--python", python, "camoufox[geoip]"])
  : ok(python, ["-m", "pip", "install", "-U", "camoufox[geoip]"]);
if (!installed) process.exit(1);
if (!ok(python, ["-m", "camoufox", "fetch"])) process.exit(1);
console.log("Camoufox is ready in .venv-camoufox.");
