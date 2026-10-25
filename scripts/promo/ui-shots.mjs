// 4K screenshots of the running app (engine + Vite) showing the promo project.
// Usage: node scripts/promo/ui-shots.mjs <outDir>
import path from "node:path";
import { launchBrowser } from "../browser.mjs";

const out = process.argv[2] ?? "D:/MantagliPromo/media";
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 });
await page.goto("http://127.0.0.1:1420/");
await page.waitForTimeout(4000);
const shot = (name) => page.screenshot({ path: path.join(out, name) });
const goTo = async (frame) => {
  await page.keyboard.press("Home");
  for (let i = 0; i < frame; i++) await page.keyboard.press("ArrowRight");
};

// Editor: chrome logo in the viewer (exact render), full timeline below.
await goTo(200);
await page.waitForTimeout(12000);
await shot("ui_editor.png");

// 3D workspace with the Logo scene selected (scene inspector, objects, render quality).
await page.locator('button:has-text("3D")').first().click();
await page.locator('button:has-text("3D Scenes")').first().click();
await page.waitForTimeout(500);
await page.locator("text=Logo").first().click();
await page.waitForTimeout(1000);
// Blender draft preview of the selected scene.
await page.locator("button:text-is(\"Render\")").first().click();
await page.waitForTimeout(15000);
await shot("ui_3d.png");
await page.locator('button:has-text("Edit")').first().click();

// Auto edit dialog.
await page.locator("button[title^='Auto edit']").first().click();
await page.waitForTimeout(800);
await shot("ui_autoedit.png");
await page.keyboard.press("Escape");

// AI Director with a brief typed in (not sent).
await page.locator('button:has-text("AI Director")').first().click();
await page.waitForTimeout(800);
const box = page.locator("textarea").last();
await box.click();
await box.type("Cut a 20 s cinematic promo to the beat: chrome 3D logo, speed ramps on the drop, gold end card.", { delay: 5 });
await page.waitForTimeout(500);
await shot("ui_director.png");
await page.locator('button:has-text("Edit")').first().click();

// Export dialog (validated, ready).
await page.keyboard.press("Escape");
await page.locator("button:has-text('Export')").first().click();
await page.waitForTimeout(2500);
await shot("ui_export.png");
await browser.close();
console.log("ui shots written to", out);
