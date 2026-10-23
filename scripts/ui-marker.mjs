// Dev utility: drag the first beat marker on the ruler.
import { chromium } from "playwright-core";
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.goto("http://127.0.0.1:1420/");
await page.waitForTimeout(3500);
const el = page.locator('[title^="downbeat"], [title^="beat"]').nth(2);
const b = await el.boundingBox();
console.log("marker at", b && Math.round(b.x), await el.getAttribute("title"));
await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
await page.mouse.down();
for (let i = 1; i <= 6; i++) await page.mouse.move(b.x + b.width / 2 + i * 5, b.y + b.height / 2);
await page.mouse.up();
await page.waitForTimeout(800);
console.log("after", await el.getAttribute("title"));
await browser.close();
