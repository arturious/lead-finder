// `npm start`. On Linux the zygote is already up before app.commandLine switches
// run, so the container flags have to be on the Electron command line itself.
const { spawn } = require("child_process");
const electron = require("electron");

const extra = process.platform === "linux"
  ? ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--in-process-gpu"]
  : [];

const child = spawn(electron, [".", ...extra], { stdio: "inherit" });
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code == null ? 1 : code);
});
