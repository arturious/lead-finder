// `npm start`. On Linux the zygote is already up before app.commandLine switches
// run, so the container flags have to be on the Electron command line itself.
const { spawn } = require("child_process");
const { repairElectron } = require("./repair-electron");

const extra = process.platform === "linux"
  ? ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--in-process-gpu"]
  : [];

repairElectron().then((result) => {
  if (result.repaired) console.log("Repaired the Electron binary from the cached zip.");
  const electron = require("electron");
  const child = spawn(electron, [".", ...extra], { stdio: "inherit" });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code == null ? 1 : code);
  });
}).catch((error) => {
  console.error(error && error.message ? error.message : error);
  process.exit(1);
});
