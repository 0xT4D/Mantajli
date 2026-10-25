// Dev utility: scrub + drag interactions in Edge, then screenshot.
import { launchBrowser } from "./browser.mjs";
const out = process.argv[2];
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const logs = [];
page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
page.on("console", (m) => m.type() === "error" && logs.push(m.text()));
await page.goto("http://127.0.0.1:1420/");
await page.waitForTimeout(3500);
// drag clip_b body 120px to the right
await page.mouse.move(1100, 805);
await page.mouse.down();
for (let i = 1; i <= 10; i++) await page.mouse.move(1100 + i * 12, 805);
await page.mouse.up();
await page.waitForTimeout(800);
// scrub to ~frame 100 on the ruler
await page.mouse.click(792, 665);
await page.waitForTimeout(6000);
await page.screenshot({ path: out });
console.log(logs.join("\n") || "no errors");
await browser.close();
