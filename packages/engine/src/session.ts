import { EventEmitter } from "node:events";
import { appendFile, readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  applyCommand,
  createProject,
  fail,
  History,
  migrateProject,
  type ChangeSource,
  type CommandName,
  type CommandParams,
  type CommandResult,
  type CreateProjectOptions,
  type Project,
} from "@mantagli/core";
import { produce } from "immer";
import { ensureDir, exists, safeName, writeFileAtomic } from "./util/fsx.js";

export const PROJECT_FILE = "project.json";
export const PROJECT_EXT = ".mantagli";
const BACKUP_KEEP = 25;
const BACKUP_MIN_INTERVAL_MS = 5 * 60 * 1000;

export type SaveState = "saved" | "dirty" | "saving" | "error";

export interface SessionChange {
  project: Project;
  label: string;
  source: ChangeSource;
  kind: "command" | "undo" | "redo" | "system" | "load";
}

export interface Transaction {
  dispatch<N extends CommandName>(name: N, params: CommandParams<N>): CommandResult<N>;
  readonly project: Project;
}

/**
 * An open project: current immutable state, undo history, persistence.
 * All mutations go through dispatch/transaction so history and autosave stay
 * consistent no matter whether the UI, the AI director or MCP made them.
 */
export class ProjectSession extends EventEmitter {
  history = new History();
  saveState: SaveState = "saved";
  lastSaveError?: string;
  recoveredFrom?: string;
  private autosaveTimer?: NodeJS.Timeout;
  private savePromise?: Promise<void>;
  private lastBackupAt = 0;
  private closed = false;

  private constructor(
    public readonly dir: string,
    private _project: Project,
  ) {
    super();
  }

  get project(): Project {
    return this._project;
  }

  get file(): string {
    return path.join(this.dir, PROJECT_FILE);
  }

  // ------------------------------------------------------------ lifecycle

  static async create(parentDir: string, opts: CreateProjectOptions): Promise<ProjectSession> {
    const dir = path.join(parentDir, safeName(opts.name) + PROJECT_EXT);
    if (await exists(path.join(dir, PROJECT_FILE))) fail("conflict", `A project already exists at ${dir}`);
    await ensureDir(dir);
    const s = new ProjectSession(dir, createProject(opts));
    await s.acquireLock();
    await s.save({ backup: false });
    return s;
  }

  /** Open a project folder (or its project.json). Recovers from backups if the main file is corrupt. */
  static async open(target: string, opts: { force?: boolean } = {}): Promise<ProjectSession> {
    const dir = path.basename(target).toLowerCase() === PROJECT_FILE ? path.dirname(target) : target;
    const file = path.join(dir, PROJECT_FILE);
    if (!(await exists(file)) && !(await exists(path.join(dir, "backups")))) fail("not_found", `No Mantagli project at ${dir}`);
    let project: Project | undefined;
    let recoveredFrom: string | undefined;
    let primaryError: string | undefined;
    try {
      project = migrateProject(JSON.parse(await readFile(file, "utf8"))).project;
    } catch (e) {
      primaryError = (e as Error).message;
      for (const b of await ProjectSession.listBackups(dir)) {
        try {
          project = migrateProject(JSON.parse(await readFile(b, "utf8"))).project;
          recoveredFrom = b;
          break;
        } catch {
          /* try older */
        }
      }
    }
    if (!project) fail("io_error", `Project file is unreadable and no valid backup exists: ${primaryError}`);
    const s = new ProjectSession(dir, project);
    s.recoveredFrom = recoveredFrom;
    await s.acquireLock(opts.force);
    await s.refreshAssetStatus();
    if (recoveredFrom) {
      // Preserve the corrupt file for inspection, then write the recovered state.
      await writeFileAtomic(path.join(dir, `project.corrupt-${Date.now()}.json`), await readFile(file).catch(() => Buffer.from("")));
      await s.save({ backup: false });
    }
    return s;
  }

  static async listBackups(dir: string): Promise<string[]> {
    const bdir = path.join(dir, "backups");
    try {
      const names = (await readdir(bdir)).filter((n) => n.endsWith(".json")).sort().reverse();
      return names.map((n) => path.join(bdir, n));
    } catch {
      return [];
    }
  }

  private get lockFile(): string {
    return path.join(this.dir, ".lock");
  }

  private async acquireLock(force = false): Promise<void> {
    if (!force && (await exists(this.lockFile))) {
      try {
        const info = JSON.parse(await readFile(this.lockFile, "utf8")) as { pid: number };
        if (info.pid !== process.pid && isAlive(info.pid))
          fail("conflict", `Project is open in another Mantagli process (pid ${info.pid}). Close it first, or connect to that instance.`, { pid: info.pid });
      } catch (e) {
        if ((e as { category?: string }).category === "conflict") throw e;
      }
    }
    await writeFileAtomic(this.lockFile, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.autosaveTimer) clearTimeout(this.autosaveTimer);
    if (this.saveState !== "saved") await this.save();
    await this.savePromise;
    await rm(this.lockFile, { force: true });
    this.removeAllListeners();
  }

  // ------------------------------------------------------------ editing

  dispatch<N extends CommandName>(name: N, params: CommandParams<N>, source: ChangeSource = "user", label?: string): CommandResult<N> {
    let result!: CommandResult<N>;
    this.transaction(label ?? name, source, (tx) => {
      result = tx.dispatch(name, params);
    });
    return result;
  }

  /**
   * Apply several commands atomically as one undo step. If `fn` throws, no
   * change is kept.
   */
  transaction<T>(label: string, source: ChangeSource, fn: (tx: Transaction) => T): T {
    this.assertOpen();
    const before = this._project;
    let working = before;
    const tx: Transaction = {
      dispatch: (name, params) => {
        const out = applyCommand(working, name, params);
        working = out.project;
        return out.result;
      },
      get project() {
        return working;
      },
    };
    const value = fn(tx);
    if (working !== before) {
      this.history.record({ label, source, before, after: working });
      this.setProject(working, { label, source, kind: "command" });
      void this.log(source, label);
    }
    return value;
  }

  /** Non-undoable bookkeeping updates (derived media, analysis, status). */
  applySystem<N extends CommandName>(name: N, params: CommandParams<N>): CommandResult<N> {
    this.assertOpen();
    const out = applyCommand(this._project, name, params);
    if (out.changed) this.setProject(out.project, { label: name, source: "system", kind: "system" });
    return out.result;
  }

  undo(): { label: string } | undefined {
    const e = this.history.undo();
    if (!e) return undefined;
    this.setProject(carryAssetState(e.before, this._project), { label: `Undo ${e.label}`, source: "user", kind: "undo" });
    return { label: e.label };
  }

  redo(): { label: string } | undefined {
    const e = this.history.redo();
    if (!e) return undefined;
    this.setProject(carryAssetState(e.after, this._project), { label: `Redo ${e.label}`, source: "user", kind: "redo" });
    return { label: e.label };
  }

  private setProject(p: Project, change: Omit<SessionChange, "project">): void {
    this._project = p;
    this.markDirty();
    this.emit("change", { project: p, ...change } satisfies SessionChange);
  }

  private assertOpen(): void {
    if (this.closed) fail("conflict", "Project session is closed");
  }

  // ------------------------------------------------------------ persistence

  private markDirty(): void {
    this.saveState = "dirty";
    this.emit("saveState", this.saveState);
    if (this.autosaveTimer) clearTimeout(this.autosaveTimer);
    this.autosaveTimer = setTimeout(() => void this.save().catch(() => {}), 1200);
  }

  async save(opts: { backup?: boolean } = {}): Promise<void> {
    if (this.autosaveTimer) clearTimeout(this.autosaveTimer);
    // Serialize saves; the latest state always wins.
    const prev = this.savePromise ?? Promise.resolve();
    const run = prev.then(async () => {
      const snapshot = this._project;
      this.saveState = "saving";
      this.emit("saveState", this.saveState);
      try {
        const json = JSON.stringify(snapshot, null, 1);
        await writeFileAtomic(this.file, json);
        const now = Date.now();
        if (opts.backup !== false && (opts.backup === true || now - this.lastBackupAt > BACKUP_MIN_INTERVAL_MS)) {
          await this.writeBackup(json);
          this.lastBackupAt = now;
        }
        this.lastSaveError = undefined;
        this.saveState = this._project === snapshot ? "saved" : "dirty";
      } catch (e) {
        this.lastSaveError = (e as Error).message;
        this.saveState = "error";
      }
      this.emit("saveState", this.saveState);
    });
    this.savePromise = run;
    await run;
    if (this.saveState === "error") fail("io_error", `Save failed: ${this.lastSaveError}`);
  }

  private async writeBackup(json: string): Promise<void> {
    const bdir = await ensureDir(path.join(this.dir, "backups"));
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await writeFileAtomic(path.join(bdir, `project-${stamp}.json`), json);
    const all = await ProjectSession.listBackups(this.dir);
    for (const old of all.slice(BACKUP_KEEP)) await rm(old, { force: true });
  }

  private async log(source: ChangeSource, label: string): Promise<void> {
    try {
      await appendFile(path.join(this.dir, "oplog.jsonl"), JSON.stringify({ at: new Date().toISOString(), source, label }) + "\n");
    } catch {
      /* logging is best-effort */
    }
  }

  async readOpLog(limit = 200): Promise<{ at: string; source: ChangeSource; label: string }[]> {
    try {
      const lines = (await readFile(path.join(this.dir, "oplog.jsonl"), "utf8")).trim().split("\n");
      return lines.slice(-limit).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  }

  // ------------------------------------------------------------ paths & assets

  cacheDir(...sub: string[]): string {
    return path.join(this.dir, "cache", ...sub);
  }

  /** Resolve a project-relative path (derived files) and refuse escapes. */
  resolveInProject(rel: string): string {
    const abs = path.resolve(this.dir, rel);
    const relCheck = path.relative(this.dir, abs);
    if (relCheck.startsWith("..") || path.isAbsolute(relCheck)) fail("permission_denied", `Path escapes the project folder: ${rel}`);
    return abs;
  }

  toProjectRelative(abs: string): string {
    return path.relative(this.dir, abs).split(path.sep).join("/");
  }

  /** Detect missing media and auto-relink files that moved along with the project. */
  async refreshAssetStatus(): Promise<{ missing: string[]; relinked: string[] }> {
    const missing: string[] = [];
    const relinked: string[] = [];
    let p = this._project;
    for (const a of p.assets) {
      if (await exists(a.path)) {
        if (a.status === "missing") p = produce(p, (d) => void (d.assets.find((x) => x.id === a.id)!.status = "ok"));
        continue;
      }
      const candidate = a.relativePath ? path.resolve(this.dir, a.relativePath) : undefined;
      if (candidate && (await exists(candidate))) {
        p = produce(p, (d) => {
          const x = d.assets.find((x) => x.id === a.id)!;
          x.path = candidate;
          x.status = "ok";
        });
        relinked.push(a.id);
      } else {
        if (a.status !== "missing") p = produce(p, (d) => void (d.assets.find((x) => x.id === a.id)!.status = "missing"));
        missing.push(a.id);
      }
    }
    if (p !== this._project) this.setProject(p, { label: "Media status refresh", source: "system", kind: "system" });
    return { missing, relinked };
  }

  async fileTimes(): Promise<{ modified?: string }> {
    try {
      return { modified: (await stat(this.file)).mtime.toISOString() };
    } catch {
      return {};
    }
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * When restoring a history snapshot, keep the newest asset bookkeeping
 * (derived files, analysis, status, path) so undo never "forgets" a proxy or
 * re-breaks a relinked file.
 */
function carryAssetState(restored: Project, current: Project): Project {
  return produce(restored, (d) => {
    for (const a of d.assets) {
      const cur = current.assets.find((x) => x.id === a.id);
      if (!cur) continue;
      a.derived = cur.derived;
      a.analysis = cur.analysis;
      a.status = cur.status;
      a.path = cur.path;
      a.meta = cur.meta;
    }
  });
}
