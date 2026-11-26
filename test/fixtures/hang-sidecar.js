const fs = require("fs");
const readline = require("readline");

process.stdout.write(`${JSON.stringify({ ready: true })}\n`);
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.cmd === "quit") process.exit(0);
  if (msg.id != null && process.env.HANG_MARK) {
    try { fs.writeFileSync(process.env.HANG_MARK, "1"); } catch { /* the test already moved on */ }
  }
});
