// UI sweep: visit every workspace, dialog and inspector headless (Edge on Windows, Chromium elsewhere), collect console
// errors, and save one screenshot per state. Needs the engine (with a project open) and Vite.
// Usage: node scripts/ui-sweep.mjs <outDir> [url]
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { launchBrowser } from "./browser.mjs";

const out = process.argv[2] ?? "tests/.tmp/ui-sweep";
mkdirSync(out, { recursive: true });
const browser = await launchBrowser();
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
const transitionSelect = () => page.locator("select:has(option[value='crossfade']):has(option[value='none'])").first();
await state("transition preset from the inspector", async () => {
  await page.locator("[data-clip-id]:has-text('clip_b.mp4')").first().click();
  await page.locator("select:has(option[value='dropWhip'])").first().selectOption("dropWhip");
  await page.waitForTimeout(400);
  const v = await transitionSelect().inputValue();
  if (v !== "whipLeft") throw new Error(`transition is ${v}, expected whipLeft`);
});
await state("save transition preset", async () => {
  await page.locator("input[placeholder='Preset name']").first().fill("Sweep whip");
  await page.locator("input[placeholder='Preset name']").first().press("Enter");
  await page.locator("button:has-text('Save'):near(input[placeholder='Preset name'])").first().click();
  await page.locator("span", { hasText: "Sweep whip" }).first().waitFor({ timeout: 3000 });
});
await state("undo preset save and apply", async () => {
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(400);
  const v = await transitionSelect().inputValue();
  if (v !== "crossfade") throw new Error(`transition is ${v} after undo, expected crossfade`);
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
await state("colour solid with a smoke backdrop (inspector)", async () => {
  await page.locator("button[title^='Insert title']").first().click();
  await page.locator("button:has-text('Colour solid')").first().click();
  await page.locator("select:has(option[value='smoke'])").first().selectOption("smoke");
  await page.locator("text=Texture").first().waitFor({ timeout: 4000 });
  await page.waitForTimeout(1500); // live backdrop raster
});
await state("undo backdrop + insert", async () => {
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+z");
});
const openInsert = async (item) => {
  await page.locator("button[title^='Insert title']").first().click();
  await page.locator(`button:has-text('${item}')`).first().click();
};
await state("generate music: compose and preview", async () => {
  await openInsert("Generate music");
  await page.locator("button:has-text('Compose & preview')").first().click();
  await page.locator("div[role=dialog] audio, audio[controls]").first().waitFor({ timeout: 90000 });
});
await state("close music", closeDialog);
await state("voice-over: estimate and preview", async () => {
  await openInsert("Voice-over");
  await page.locator("div[role=dialog] textarea").first().fill("This year, the arena opens again.\n\nSeventh edition. Join us.");
  await page.locator("div[role=dialog] textarea").first().blur();
  await page.locator("button:has-text('Estimate timing')").first().click();
  await page.locator("div[role=dialog] >> text=/Estimated/").first().waitFor({ timeout: 10000 });
  await page.locator("button:has-text('Preview first segment')").first().click();
  await page.locator("audio[controls]").first().waitFor({ timeout: 60000 });
});
await state("voice-over: compare local engines", async () => {
  await page.locator("button:has-text('Compare engines')").first().click();
  await page.locator("[data-testid=voice-compare] audio").nth(1).waitFor({ timeout: 90000 });
});
await state("close voice-over", closeDialog);
await state("sound design: suggestions and mix meter", async () => {
  await openInsert("Sound design");
  await page.locator("div[role=dialog] label").or(page.locator("div[role=dialog]").getByText("Nothing to add")).first().waitFor({ timeout: 10000 });
  await page.locator("button:has-text('Measure mix')").first().click();
  await page.locator("div[role=dialog] >> text=/Integrated/").first().waitFor({ timeout: 120000 });
});
await state("close sound design", closeDialog);
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
