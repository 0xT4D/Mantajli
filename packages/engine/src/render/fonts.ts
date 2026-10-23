import path from "node:path";
import { exists } from "../util/fsx.js";

/** Common families and their regular/bold files in the Windows font folder. */
const WINDOWS_FONTS: Record<string, [string, string]> = {
  Arial: ["arial.ttf", "arialbd.ttf"],
  "Arial Black": ["ariblk.ttf", "ariblk.ttf"],
  Impact: ["impact.ttf", "impact.ttf"],
  "Segoe UI": ["segoeui.ttf", "segoeuib.ttf"],
  Bahnschrift: ["bahnschrift.ttf", "bahnschrift.ttf"],
  Verdana: ["verdana.ttf", "verdanab.ttf"],
  Tahoma: ["tahoma.ttf", "tahomabd.ttf"],
  Georgia: ["georgia.ttf", "georgiab.ttf"],
  "Times New Roman": ["times.ttf", "timesbd.ttf"],
  "Trebuchet MS": ["trebuc.ttf", "trebucbd.ttf"],
  "Courier New": ["cour.ttf", "courbd.ttf"],
  Consolas: ["consola.ttf", "consolab.ttf"],
  "Franklin Gothic": ["framd.ttf", "frahv.ttf"],
  "Century Gothic": ["GOTHIC.TTF", "GOTHICB.TTF"],
};

function fontDirs(): string[] {
  if (process.platform === "win32") {
    const win = process.env.WINDIR ?? "C:\Windows";
    return [path.join(win, "Fonts"), path.join(process.env.LOCALAPPDATA ?? "", "Microsoft", "Windows", "Fonts")];
  }
  if (process.platform === "darwin") return ["/System/Library/Fonts/Supplemental", "/Library/Fonts"];
  return ["/usr/share/fonts/truetype/msttcorefonts", "/usr/share/fonts/truetype/dejavu"];
}

const cache = new Map<string, string | null>();

/** Resolve a family + weight to a font file, or undefined if unavailable. */
export async function resolveFontFile(family: string, bold: boolean): Promise<string | undefined> {
  const key = `${family}|${bold}`;
  if (cache.has(key)) return cache.get(key) ?? undefined;
  const files = WINDOWS_FONTS[family];
  let found: string | undefined;
  if (files) {
    for (const dir of fontDirs()) {
      const p = path.join(dir, bold ? files[1] : files[0]);
      if (await exists(p)) {
        found = p;
        break;
      }
    }
  }
  cache.set(key, found ?? null);
  return found;
}

/** Families that resolve to an installed file (for the UI font picker). */
export async function availableFontFamilies(): Promise<string[]> {
  const out: string[] = [];
  for (const family of Object.keys(WINDOWS_FONTS)) if (await resolveFontFile(family, false)) out.push(family);
  return out;
}

export async function defaultFontFile(bold = true): Promise<string | undefined> {
  return (await resolveFontFile("Arial", bold)) ?? (await resolveFontFile("Segoe UI", bold));
}
