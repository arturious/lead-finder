const readline = require("readline");

process.stdout.write(`${JSON.stringify({ ready: true })}\n`);
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.cmd === "stop") {
    process.stdout.write(`${JSON.stringify({ stopped: true })}\n`);
    process.exit(0);
  }
  const challenge = String(msg.url || "").includes("challenge");
  process.stdout.write(`${JSON.stringify({
    id: msg.id,
    status: challenge ? 403 : 200,
    html: challenge ? "<title>Just a moment...</title> challenge-platform" : `ok ${process.env.LEADFINDER_PROXY || ""}`,
    finalUrl: msg.url,
    ms: 15,
    challenge
  })}\n`);
});
