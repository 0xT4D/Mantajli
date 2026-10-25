// Headless browser for the UI scripts: Microsoft Edge on Windows (no browser download),
// otherwise a Chromium build. MANTAGLI_CHROMIUM overrides the executable.
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";

export function launchBrowser() {
  const exe = process.env.MANTAGLI_CHROMIUM ?? ["/opt/pw-browsers/chromium", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"].find((p) => existsSync(p));
  if (process.platform === "win32" && !process.env.MANTAGLI_CHROMIUM) return chromium.launch({ channel: "msedge", headless: true });
  return chromium.launch({ headless: true, ...(exe ? { executablePath: exe } : {}) });
}
