// UI sweep: visit every workspace, dialog and inspector in headless Edge, collect console
// errors, and save one screenshot per state. Needs the engine (with a project open) and Vite.
// Usage: node scripts/ui-sweep.mjs <outDir> [url]
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const out = process.argv[2] ?? "tests/.tmp/ui-sweep";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(`console: ${m.text()}`));
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
await page.goto(process.argv[3] ?? "http://127.0.0.1:1420/");
await page.waitForTimeout(3000);

const results = [];
let n = 0;
async function state(name, fn) {
  const before = errors.length;
  let error = "";
  try {
    await fn();
    await page.waitForTimeout(700);
  } catch (e) {
    error = String(e.message ?? e).split("\n")[0];
  }
  const file = `${String(++n).padStart(2, "0")}-${name.replace(/\W+/g, "-")}.png`;
  await page.screenshot({ path: path.join(out, file) });
  results.push({ name, file, ok: !error && errors.length === before, error: error || errors.slice(before).join(" | ") });
}
const closeDialog = async () => {
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  const x = page.locator("div[role=dialog] button[title^=Close], button:has-text('Close'), button:has-text('Cancel')").first();
  if (await x.isVisible().catch(() => false)) await x.click();
};
const ws = (label) => page.locator(`button:has-text("${label}")`).first().click();

await state("edit workspace", async () => {});
await state("color workspace", () => ws("Color"));
await state("3d workspace", () => ws("3D"));
await state("ai director workspace", () => ws("AI Director"));
await state("back to edit", () => ws("Edit"));
await state("media bin: video filter", () => page.locator("button:has-text('video')").first().click());
await state("media bin: all + asset selected", async () => {
  await page.locator("button:has-text('all')").first().click();
  await page.locator("[title*='clip_a.mp4']").first().click();
});
await state("3D scenes tab", () => page.locator("button:has-text('3D Scenes')").first().click());
await state("looks tab", () => page.locator("button:has-text('Looks')").first().click());
await state("media tab", () => page.locator("button:has-text('Media')").first().click());
await state("timeline: select a clip (clip inspector)", async () => {
  const clip = page.locator("[data-clip-id]").first();
  if (await clip.count()) await clip.click();
  else await page.mouse.click(700, 805);
});
await state("timeline: select a track (track inspector)", () => page.locator("text=V1").first().click());
await state("play 1.5 s (live compositor)", async () => {
  await page.keyboard.press("Home");
  await page.keyboard.press("Space");
  await page.waitForTimeout(1500);
  await page.keyboard.press("Space");
});
await state("step frames + exact render", async () => {
  for (let i = 0; i < 10; i++) await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(2500);
});
await state("timeline insert menu", async () => {
  await page.locator("button[title^='Insert title']").first().click();
  await page.locator("button:has-text('Adjustment layer')").first().waitFor({ timeout: 2000 });
});
await state("insert adjustment layer (inspector)", async () => {
  await page.locator("button:has-text('Adjustment layer')").first().click();
  await page.locator("text=/Adjustment ·/").first().waitFor({ timeout: 4000 });
});
await state("undo the insert", () => page.keyboard.press("Control+z"));
await state("add track menu", async () => {
  await page.locator("button[title='Add track']").first().click();
  await page.locator("button:has-text('Audio track')").first().waitFor({ timeout: 2000 });
  await page.keyboard.press("Escape");
  await page.mouse.move(10, 10);
});
await state("export dialog (OTIO + captions sections)", () => page.locator("button:has-text('Export')").first().click());
await state("close export", closeDialog);
await state("settings dialog", () => page.locator("button[title^='Settings']").first().click());
await state("close settings", closeDialog);
await state("auto edit dialog", () => page.locator("button[title^='Auto edit']").first().click());
await state("close auto edit", closeDialog);
await state("open project dialog", () => page.locator("button[title^='Open project']").first().click());
await state("close open dialog", closeDialog);
await state("undo / redo shortcuts", async () => {
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+Shift+z");
});
await state("job list popover", () => page.locator("text=/background job|No background jobs|task/").last().click());

writeFileSync(path.join(out, "ui-sweep.json"), JSON.stringify({ results, errors }, null, 1));
for (const r of results) console.log(`${r.ok ? "✓" : "✗"} ${r.name}${r.error ? ` — ${r.error}` : ""}`);
console.log(`${results.filter((r) => r.ok).length}/${results.length} UI states clean`);
await browser.close();
