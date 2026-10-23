// Bundles the engine host for the desktop app into dist-engine/:
//   engine.mjs                 single-file ESM bundle of packages/engine/src/main.ts
//   blender/mantagli_scene.py  Blender scene builder
//   node(.exe)                 the Node.js runtime used to build (shipped with the app)
// Then smoke-tests the bundle by starting it and waiting for the ready line.
import { spawn } from "node:child_process";
import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "dist-engine");
await rm(out, { recursive: true, force: true });
await mkdir(path.join(out, "blender"), { recursive: true });

await build({
  entryPoints: [path.join(root, "packages/engine/src/main.ts")],
  outfile: path.join(out, "engine.mjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: "linked",
  // ws has optional native accelerators; it works without them.
  external: ["bufferutil", "utf-8-validate"],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: "warning",
});
await copyFile(path.join(root, "blender/mantagli_scene.py"), path.join(out, "blender/mantagli_scene.py"));
const nodeName = process.platform === "win32" ? "node.exe" : "node";
await copyFile(process.execPath, path.join(out, nodeName));
console.log(`engine bundled -> ${out}`);

// Smoke test: the bundle must start and report readiness.
await new Promise((resolve, reject) => {
  const child = spawn(path.join(out, nodeName), [path.join(out, "engine.mjs"), "--watch-stdin"], {
    env: { ...process.env, MANTAGLI_HOME: path.join(root, "tests/.tmp/home-bundle"), MANTAGLI_BLENDER_SCRIPT: path.join(out, "blender/mantagli_scene.py") },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const timer = setTimeout(() => {
    child.kill();
    reject(new Error("bundled engine did not become ready within 60 s"));
  }, 60000);
  child.stdout.setEncoding("utf8").on("data", (d) => {
    if (d.includes("MANTAGLI_ENGINE_READY")) {
      clearTimeout(timer);
      console.log(`smoke test ok: ${d.trim().slice(0, 120)}…`);
      child.stdin.end();
      child.on("exit", resolve);
    }
  });
  child.on("error", reject);
});
