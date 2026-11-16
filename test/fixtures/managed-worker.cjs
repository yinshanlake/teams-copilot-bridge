const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..", "..");
const state = path.join(root, "state");
if (process.argv.includes("--check")) {
  console.log(JSON.stringify({
    configuration: "valid", transport: "relay", host: "127.0.0.1",
    port: 59991, stateDirectory: state,
  }));
  process.exit(0);
}
fs.mkdirSync(state, { recursive: true });
const countPath = path.join(root, "attempts.txt");
const count = fs.existsSync(countPath) ? Number(fs.readFileSync(countPath, "utf8")) + 1 : 1;
fs.writeFileSync(countPath, String(count));
fs.writeFileSync(path.join(state, "bridge.lock"), JSON.stringify({
  pid: process.pid, id: require("node:crypto").randomUUID(),
}));
console.log(JSON.stringify({ area: "fixture-worker", status: "started", password: "DO_NOT_LOG_FIXTURE_SECRET" }));
console.error("DO_NOT_LOG_RAW_FIXTURE_SECRET");
const mode = fs.readFileSync(path.join(root, "mode.txt"), "utf8");
if (mode === "crash-once") process.exit(count === 1 ? 23 : 0);
if (mode === "crash-loop") process.exit(23);
if (mode === "log-limit-kick") {
  const field = "A".repeat(100);
  const line = JSON.stringify({ level: field, area: field, kind: field, code: field, transport: field, status: field, outcome: field });
  for (let index = 0; index < 7000; index++) console.log(line);
  process.stdout.write(JSON.stringify({ transport: "relay", status: "kicked" }) + "\n", () => process.exit(17));
  return;
}
if (mode === "auth-stop") {
  console.log(JSON.stringify({ transport: "relay", status: "kicked" }));
  process.exit(17);
}
if (mode !== "hold") process.exit(24);
setInterval(() => {
  if (fs.existsSync(path.join(root, "stop.txt"))) {
    fs.unlinkSync(path.join(state, "bridge.lock"));
    process.exit(0);
  }
}, 100);
