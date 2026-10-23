import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Atomic write: write a sibling temp file, fsync it, then rename over the
 * target. A crash mid-write leaves the previous file intact.
 */
export async function writeFileAtomic(target: string, data: string | Uint8Array): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${randomBytes(4).toString("hex")}.tmp`;
  const fh = await open(tmp, "w");
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await rename(tmp, target);
  } catch (e) {
    // Windows can transiently refuse rename while a reader holds the file.
    await new Promise((r) => setTimeout(r, 50));
    try {
      await rename(tmp, target);
    } catch {
      await rm(tmp, { force: true });
      throw e;
    }
  }
}

export async function readJson<T = unknown>(p: string): Promise<T> {
  return JSON.parse(await readFile(p, "utf8")) as T;
}

/**
 * Fast fingerprint for duplicate detection: size + SHA-1 of the first and last
 * 1 MiB. Never reads whole media files into memory.
 */
export async function quickHash(p: string): Promise<string> {
  const { size } = await stat(p);
  const h = createHash("sha1");
  h.update(String(size));
  const chunk = 1 << 20;
  const ranges: [number, number][] = size <= 2 * chunk ? [[0, Math.max(0, size - 1)]] : [[0, chunk - 1], [size - chunk, size - 1]];
  for (const [start, end] of ranges) {
    if (size === 0) break;
    await new Promise<void>((resolve, reject) => {
      createReadStream(p, { start, end })
        .on("data", (d) => h.update(d))
        .on("end", () => resolve())
        .on("error", reject);
    });
  }
  return h.digest("hex").slice(0, 24);
}

export function sha1(s: string): string {
  return createHash("sha1").update(s).digest("hex");
}

/** True if `child` is inside (or equal to) `parent`. */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Make a string safe as a single path segment. */
export function safeName(s: string, fallback = "untitled"): string {
  const cleaned = s.replace(/[<>:"/\|?*\x00-\x1f]/g, "_").replace(/\s+/g, " ").trim().replace(/^\.+/, "").slice(0, 80);
  return cleaned || fallback;
}

export async function ensureDir(p: string): Promise<string> {
  await mkdir(p, { recursive: true });
  return p;
}

export { writeFile };
