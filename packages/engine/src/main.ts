/**
 * Engine host entry point.
 *
 *   node main.js [--port N] [--open <project dir>] [--watch-stdin]
 *
 * Prints one line `MANTAGLI_ENGINE_READY {"port":…,"token":…}` when ready.
 * The desktop shell reads that line, passes the connection to the UI and
 * keeps stdin open; when the shell exits, stdin closes and the engine saves
 * and shuts down.
 */
import { Engine } from "./engine.js";
import { EngineServer } from "./server.js";

// node:sqlite and other experimental warnings would pollute stdout parsing.
process.removeAllListeners("warning");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const engine = new Engine();
await engine.init();
const server = new EngineServer(engine, { token: process.env.MANTAGLI_ENGINE_TOKEN });
const port = await server.listen(Number(arg("port") ?? process.env.MANTAGLI_ENGINE_PORT ?? 0));

const open = arg("open");
if (open) {
  try {
    await engine.openProject(open);
  } catch (e) {
    console.error(`Could not open ${open}: ${(e as Error).message}`);
  }
}

let stopping = false;
async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  try {
    await server.close();
  } finally {
    process.exit(code);
  }
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
if (process.argv.includes("--watch-stdin")) {
  process.stdin.resume();
  process.stdin.on("end", () => void shutdown());
  process.stdin.on("close", () => void shutdown());
}
process.on("uncaughtException", (e) => {
  console.error("uncaught", e);
});

console.log(`MANTAGLI_ENGINE_READY ${JSON.stringify({ port, token: server.token, deps: { ffmpeg: !!engine.deps.ffmpeg, blender: !!engine.deps.blender }, problems: engine.deps.problems })}`);
