import type { Project } from "./schema.js";

export type ChangeSource = "user" | "ai" | "mcp" | "system";

export interface HistoryEntry {
  label: string;
  source: ChangeSource;
  at: string;
  before: Project;
  after: Project;
}

/**
 * Snapshot-based undo/redo. Projects are immutable (immer structural sharing),
 * so each entry costs only the changed branches.
 */
export class History {
  private past: HistoryEntry[] = [];
  private future: HistoryEntry[] = [];

  constructor(private readonly limit = 300) {}

  record(entry: Omit<HistoryEntry, "at">): void {
    this.past.push({ ...entry, at: new Date().toISOString() });
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
  }

  canUndo(): boolean {
    return this.past.length > 0;
  }

  canRedo(): boolean {
    return this.future.length > 0;
  }

  /** Returns the project to restore, or undefined if nothing to undo. */
  undo(): HistoryEntry | undefined {
    const e = this.past.pop();
    if (e) this.future.push(e);
    return e;
  }

  redo(): HistoryEntry | undefined {
    const e = this.future.pop();
    if (e) this.past.push(e);
    return e;
  }

  clear(): void {
    this.past = [];
    this.future = [];
  }

  /** Labels newest-first, for the history panel. */
  list(): { undo: { label: string; source: ChangeSource; at: string }[]; redo: { label: string; source: ChangeSource; at: string }[] } {
    const strip = (e: HistoryEntry) => ({ label: e.label, source: e.source, at: e.at });
    return { undo: this.past.map(strip).reverse(), redo: this.future.map(strip).reverse() };
  }
}
