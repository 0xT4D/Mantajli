import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { SCHEMA_VERSION, type HistoryEntry, type Project } from "@mantagli/core";
import { writeFileAtomic } from "./util/fsx.js";

/**
 * Persistent undo history.
 *
 * History snapshots share structure in memory (immer), so they are stored the
 * same way on disk: every JSON object/array is written once under the hash of
 * its content (children referenced by hash). Hashes are cached per object
 * identity — snapshots are immutable — so saving only hashes new branches.
 *
 * The file records a hash of the project.json text it was saved with; history
 * is restored only when that matches the file being opened (and the schema
 * version), so a project edited elsewhere never gets a wrong undo stack.
 */

export const HISTORY_FILE = "history.json";
const FORMAT = 1;

type Ref = { $h: string };
type Encoded = unknown;

interface HistoryFile {
  format: number;
  schemaVersion: number;
  head: string;
  nodes: Record<string, string>;
  past: StoredEntry[];
  future: StoredEntry[];
}
interface StoredEntry {
  label: string;
  source: HistoryEntry["source"];
  at: string;
  before: string;
  after: string;
}

const isRef = (v: unknown): v is Ref => typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 1 && typeof (v as Ref).$h === "string";

export class SnapshotEncoder {
  private ids = new WeakMap<object, string>();
  nodes = new Map<string, string>();

  /** Hash of a JSON value; objects and arrays are stored in `nodes`. */
  hash(value: unknown): string {
    if (typeof value !== "object" || value === null) return `v:${JSON.stringify(value)}`;
    const known = this.ids.get(value);
    if (known && this.nodes.has(known)) return known;
    const enc = (v: unknown): Encoded => (typeof v === "object" && v !== null ? { $h: this.hash(v) } : v);
    let body: Encoded;
    if (Array.isArray(value)) body = value.map(enc);
    else {
      const o: Record<string, Encoded> = {};
      for (const [k, v] of Object.entries(value)) if (v !== undefined) o[k] = enc(v);
      // A literal object shaped like a reference must not be confused with one.
      body = isRef(o) ? { $lit: o } : o;
    }
    const text = JSON.stringify(body);
    const h = createHash("sha1").update(text).digest("base64url").slice(0, 22);
    this.nodes.set(h, text);
    this.ids.set(value, h);
    return h;
  }

  /** Nodes reachable from the given roots (what needs writing). */
  reachable(roots: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    const visit = (h: string) => {
      if (h.startsWith("v:") || out[h]) return;
      const text = this.nodes.get(h);
      if (text === undefined) throw new Error(`history node ${h} missing`);
      out[h] = text;
      walkRefs(JSON.parse(text), visit);
    };
    roots.forEach(visit);
    return out;
  }
}

function walkRefs(v: unknown, fn: (h: string) => void): void {
  if (Array.isArray(v)) v.forEach((x) => walkRefs(x, fn));
  else if (isRef(v)) fn(v.$h);
  else if (typeof v === "object" && v !== null) for (const x of Object.values((v as { $lit?: unknown }).$lit ?? v)) walkRefs(x, fn);
}

/** Rebuild values from stored nodes, sharing decoded subtrees like the originals did. */
function decoder(nodes: Record<string, string>) {
  const memo = new Map<string, unknown>();
  const dec = (h: string): unknown => {
    if (h.startsWith("v:")) return JSON.parse(h.slice(2));
    if (memo.has(h)) return memo.get(h);
    const text = nodes[h];
    if (text === undefined) throw new Error(`history node ${h} missing`);
    const body = JSON.parse(text) as unknown;
    const conv = (v: unknown): unknown => (isRef(v) ? dec(v.$h) : v);
    let value: unknown;
    if (Array.isArray(body)) value = body.map(conv);
    else {
      const src = (body as { $lit?: Record<string, unknown> }).$lit ?? (body as Record<string, unknown>);
      value = Object.fromEntries(Object.entries(src).map(([k, v]) => [k, conv(v)]));
    }
    Object.freeze(value);
    memo.set(h, value);
    return value;
  };
  return dec;
}

/** Hash identifying a saved project.json text. */
export function projectTextHash(json: string): string {
  return createHash("sha1").update(json).digest("hex");
}

export async function writeHistory(file: string, enc: SnapshotEncoder, headTextHash: string, entries: { past: readonly HistoryEntry[]; future: readonly HistoryEntry[] }): Promise<void> {
  const store = (e: HistoryEntry): StoredEntry => ({ label: e.label, source: e.source, at: e.at, before: enc.hash(e.before), after: enc.hash(e.after) });
  const past = entries.past.map(store);
  const future = entries.future.map(store);
  const nodes = enc.reachable([...past.flatMap((e) => [e.before, e.after]), ...future.flatMap((e) => [e.before, e.after])]);
  // Forget nodes no entry uses any more (their objects re-hash if seen again).
  enc.nodes = new Map(Object.entries(nodes));
  const data: HistoryFile = { format: FORMAT, schemaVersion: SCHEMA_VERSION, head: headTextHash, nodes, past, future };
  await writeFileAtomic(file, JSON.stringify(data));
}

/** Load persisted history for the project.json text with this hash; undefined when absent, unreadable or stale. */
export async function readHistory(file: string, headTextHash: string): Promise<{ past: HistoryEntry[]; future: HistoryEntry[] } | undefined> {
  let data: HistoryFile;
  try {
    data = JSON.parse(await readFile(file, "utf8")) as HistoryFile;
  } catch {
    return undefined;
  }
  if (data.format !== FORMAT || data.schemaVersion !== SCHEMA_VERSION || data.head !== headTextHash) return undefined;
  try {
    const dec = decoder(data.nodes);
    const load = (e: StoredEntry): HistoryEntry => ({ label: e.label, source: e.source, at: e.at, before: dec(e.before) as Project, after: dec(e.after) as Project });
    return { past: data.past.map(load), future: data.future.map(load) };
  } catch {
    return undefined;
  }
}
