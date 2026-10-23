import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";

/**
 * Dev-only: lets the browser UI discover a locally running engine
 * (`npm run engine`) by reading the engine connection file. Never part of
 * production builds; the desktop shell passes the connection via IPC.
 */
function engineDiscovery(): Plugin {
  const file = path.join(
    process.env.MANTAGLI_HOME ??
      (process.platform === "win32" ? path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "Mantagli") : path.join(os.homedir(), ".config", "mantagli")),
    "engine.json",
  );
  return {
    name: "mantagli-engine-discovery",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__engine", async (_req, res) => {
        try {
          const info = JSON.parse(await readFile(file, "utf8"));
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ port: info.port, token: info.token }));
        } catch {
          res.statusCode = 404;
          res.end("{}");
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), engineDiscovery()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, host: "127.0.0.1" },
  build: { target: "es2022", outDir: "dist", chunkSizeWarningLimit: 2000 },
});
