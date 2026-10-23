// Dev utility: drag the "SFX" track header above "V1".
import { chromium } from "playwright-core";
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.goto("http://127.0.0.1:1420/");
await page.waitForTimeout(3500);
const icon = page.locator('span[title="Drag to reorder"]').nth(4);
const b = await icon.boundingBox();
await page.mouse.move(b.x + 5, b.y + 5);
await page.mouse.down();
for (let i = 1; i <= 8; i++) await page.mouse.move(b.x + 5, b.y + 5 - i * 20);
await page.mouse.up();
await page.waitForTimeout(800);
console.log(await page.locator('span[title="Drag to reorder"] + span').allInnerTexts());
await browser.close();
