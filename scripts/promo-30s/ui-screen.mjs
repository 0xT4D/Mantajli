// Screenshot of the real app with the promo project open, for the promo's stage screen.
// Needs the dev engine (MANTAGLI_HOME as the engine) and Vite running.
// Usage: node scripts/promo-30s/ui-screen.mjs [projectDir] [out.png]
import { readFileSync } from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import { launchBrowser } from "../browser.mjs";

const root = path.resolve(import.meta.dirname, "../../tests/.tmp/promo-30s");
const project = process.argv[2] ?? path.join(root, "Mantagli Promo 30s.mantagli");
const out = process.argv[3] ?? path.join(root, "media", "app-ui.png");
const home = process.env.MANTAGLI_HOME ?? path.resolve(import.meta.dirname, "../../tests/.tmp/home-ui");
const { port, token } = JSON.parse(readFileSync(path.join(home, "engine.json"), "utf8"));
const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc?token=${token}`);
await new Promise((r, j) => (ws.once("open", r), ws.once("error", j)));
let id = 0;
const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const my = ++id;
    const on = (m) => {
      const msg = JSON.parse(String(m));
      if (msg.id !== my) return;
      ws.off("message", on);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    };
    ws.on("message", on);
    ws.send(JSON.stringify({ id: my, method, params }));
  });

const before = await call("project.state");
const settings = await call("app.updateSettings", { patch: {} });
await call("app.updateSettings", { patch: { autoRenderScenes: false } });
await call("project.open", { path: project, force: true });
const browser = await launchBrowser();
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.goto("http://127.0.0.1:1420/");
  await page.waitForTimeout(3500);
  const card = page.locator("[data-clip-id]").filter({ hasText: /^\s*Type\s*$/ }).first();
  const box = await card.boundingBox();
  const ruler = await page.locator("div.sticky.top-0.z-20").first().boundingBox();
  // Playhead onto the card (ruler click), then select the card so the inspector shows its backdrop.
  await page.mouse.click(box.x + box.width * 0.6, ruler.y + ruler.height / 2);
  await page.waitForTimeout(500);
  await card.click();
  await page.waitForTimeout(6000); // exact frame render
  await page.screenshot({ path: out });
  console.log("wrote", out);
} finally {
  await browser.close();
  await call("app.updateSettings", { patch: { autoRenderScenes: settings.autoRenderScenes } });
  if (before?.dir) await call("project.open", { path: before.dir, force: true });
  ws.close();
}
