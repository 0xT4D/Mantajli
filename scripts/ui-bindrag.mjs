// Dev utility: drag a bin item onto the timeline with real pointer events.
import { chromium } from "playwright-core";
const [out, fx, fy, tx, ty] = process.argv.slice(2);
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const logs = [];
page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
await page.goto("http://127.0.0.1:1420/");
await page.waitForTimeout(3500);
await page.mouse.move(+fx, +fy);
await page.mouse.down();
for (let i = 1; i <= 20; i++) await page.mouse.move(+fx + ((tx - fx) * i) / 20, +fy + ((ty - fy) * i) / 20);
await page.screenshot({ path: out.replace(".png", "-during.png") });
await page.mouse.up();
await page.waitForTimeout(2500);
await page.screenshot({ path: out });
console.log(logs.join("\n") || "no errors");
await browser.close();
