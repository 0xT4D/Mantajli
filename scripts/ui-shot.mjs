// Dev utility: screenshot the UI in Microsoft Edge (no browser download).
// Usage: node scripts/ui-shot.mjs <out.png> [url] [actionsJson]
import { chromium } from "playwright-core";
const [out = "ui.png", url = "http://127.0.0.1:1420/", actions = "[]"] = process.argv.slice(2);
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const logs = [];
page.on("console", (m) => (m.type() === "error" || m.type() === "warning") && logs.push(`${m.type()}: ${m.text()}`));
page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
await page.goto(url);
await page.waitForTimeout(2500);
for (const a of JSON.parse(actions)) {
  if (a.click) await page.click(a.click);
  if (a.key) await page.keyboard.press(a.key);
  if (a.mouse) await page.mouse.click(a.mouse[0], a.mouse[1]);
  if (a.wait) await page.waitForTimeout(a.wait);
}
await page.screenshot({ path: out });
console.log(logs.slice(0, 20).join("\n") || "no console errors");
await browser.close();
