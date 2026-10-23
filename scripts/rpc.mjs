// Dev utility: call the running engine. Usage: node scripts/rpc.mjs <method> [paramsJson]
import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import WebSocket from "ws";
const home = process.env.MANTAGLI_HOME ?? path.join(process.env.APPDATA ?? path.join(os.homedir(), ".config"), "Mantagli");
const { port, token } = JSON.parse(readFileSync(path.join(home, "engine.json"), "utf8"));
const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc?token=${token}`);
ws.on("open", () => ws.send(JSON.stringify({ id: 1, method: process.argv[2], params: JSON.parse(process.argv[3] ?? "{}") })));
ws.on("message", (m) => {
  const msg = JSON.parse(String(m));
  if (msg.id !== 1) return;
  console.log(JSON.stringify(msg.error ?? msg.result, null, 1));
  ws.close();
});
