import { create } from "zustand";
import type { CommandName, CommandParams, Project } from "@mantagli/core";
import { engine, EngineError } from "../engine/client";

export interface DepsInfo {
  ffmpeg?: { path: string; version: string };
  ffprobe?: { path: string };
  blender?: { path: string; version: string; engines: string[]; importers: string[]; cyclesDevice?: string };
  problems: string[];
}

export interface AppInfo {
  version: string;
  deps: DepsInfo;
  settings: {
    blenderPath?: string;
    ffmpegPath?: string;
    projectsDir?: string;
    recentProjects: string[];
    aiModel: string;
    aiAutonomy: "review" | "autonomous";
    aiMediaFolders: string[];
    previewScale: number;
    autoRenderScenes: boolean;
    ui: Record<string, unknown>;
  };
  projectsDir: string;
  ai: { hasKey: boolean; model: string };
  platform: string;
}

export interface JobInfo {
  id: string;
  type: string;
  label: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  progress: number | null;
  message?: string;
  createdAt: string;
  finishedAt?: string;
  outputs: string[];
  error?: { category: string; message: string };
  result?: unknown;
}

export type DirectorEvent =
  | { type: "status"; status: string; at: string }
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_call"; callId: string; name: string; input: unknown }
  | { type: "tool_result"; callId: string; name: string; ok: boolean; summary: string; error?: string; images?: string[] }
  | { type: "approval_request"; approvalId: string; tool: string; summary: string }
  | { type: "approval_resolved"; approvalId: string; approved: boolean }
  | { type: "error"; message: string };

export interface DirectorRun {
  id: string;
  brief: string;
  status: "running" | "awaiting_approval" | "done" | "failed" | "cancelled";
  startedAt: string;
  finishedAt?: string;
  events: DirectorEvent[];
  steps: number;
  changed: boolean;
  decision?: "accepted" | "reverted";
  usage: { inputTokens: number; outputTokens: number };
}

export type Selection =
  | { kind: "none" }
  | { kind: "clips"; ids: string[] }
  | { kind: "track"; id: string }
  | { kind: "asset"; id: string }
  | { kind: "scene"; id: string }
  | { kind: "sceneObject"; sceneId: string; id: string }
  | { kind: "marker"; id: string }
  | { kind: "project" };

export type Workspace = "edit" | "3d" | "color" | "ai";

export interface Toast {
  id: number;
  kind: "error" | "info" | "ok";
  text: string;
}

interface SessionState {
  open: boolean;
  dir?: string;
  project?: Project;
  saveState?: "saved" | "dirty" | "saving" | "error";
  canUndo?: boolean;
  canRedo?: boolean;
  recoveredFrom?: string;
}

interface StudioState {
  connection: "connecting" | "connected" | "disconnected" | "error";
  connectionError?: string;
  info?: AppInfo;
  session: SessionState;
  jobs: Record<string, JobInfo>;
  runs: Record<string, DirectorRun>;
  selection: Selection;
  playhead: number;
  playing: boolean;
  /** Pixels per frame on the timeline. */
  zoom: number;
  workspace: Workspace;
  snapping: boolean;
  toasts: Toast[];
  dialog: null | "newProject" | "openProject" | "export" | "settings" | "autoEdit";
  aiPanelOpen: boolean;

  init(): Promise<void>;
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  dispatch<N extends CommandName>(name: N, params: CommandParams<N>, label?: string): Promise<unknown>;
  transaction(label: string, commands: { name: CommandName; params: unknown }[]): Promise<unknown>;
  undo(): Promise<void>;
  redo(): Promise<void>;
  setSelection(s: Selection): void;
  setPlayhead(f: number): void;
  setPlaying(p: boolean): void;
  setZoom(z: number): void;
  setWorkspace(w: Workspace): void;
  setDialog(d: StudioState["dialog"]): void;
  toast(kind: Toast["kind"], text: string): void;
  dismissToast(id: number): void;
  toggleAiPanel(open?: boolean): void;
  updateSettings(patch: Partial<AppInfo["settings"]>): Promise<void>;
  set(partial: Partial<StudioState>): void;
}

let toastId = 1;

export const useStudio = create<StudioState>((set, get) => ({
  connection: "connecting",
  session: { open: false },
  jobs: {},
  runs: {},
  selection: { kind: "none" },
  playhead: 0,
  playing: false,
  zoom: 4,
  workspace: "edit",
  snapping: true,
  toasts: [],
  dialog: null,
  aiPanelOpen: true,

  async init() {
    engine.on("connection", (ok) => set({ connection: ok ? "connected" : "disconnected" }));
    engine.on("project", (d) => {
      const data = d as { project: Project; canUndo: boolean; canRedo: boolean };
      set((s) => ({ session: { ...s.session, project: data.project, canUndo: data.canUndo, canRedo: data.canRedo } }));
    });
    engine.on("saveState", (d) => set((s) => ({ session: { ...s.session, saveState: (d as { state: SessionState["saveState"] }).state } })));
    engine.on("projectOpened", (d) => {
      set({ session: d as SessionState, selection: { kind: "none" }, playhead: 0, playing: false, runs: {} });
      const rec = (d as SessionState).recoveredFrom;
      if (rec) get().toast("info", `Project file was damaged; recovered from backup ${rec.split(/[\\/]/).pop()}`);
    });
    engine.on("projectClosed", () => set({ session: { open: false }, selection: { kind: "none" } }));
    engine.on("job", (j) => {
      const job = j as JobInfo;
      set((s) => ({ jobs: { ...s.jobs, [job.id]: job } }));
      if (job.status === "failed" && (job.type === "export" || job.type === "scene")) get().toast("error", `${job.label} failed: ${job.error?.message ?? "unknown error"}`);
      if (job.status === "done" && job.type === "export") get().toast("ok", `Export finished: ${job.outputs[0] ?? ""}`);
    });
    engine.on("deps", (d) => set((s) => (s.info ? { info: { ...s.info, deps: d as DepsInfo } } : {})));
    engine.on("ai.run", (r) => {
      const run = r as DirectorRun;
      set((s) => ({ runs: { ...s.runs, [run.id]: run } }));
    });
    engine.on("ai.event", (e) => {
      const { runId, event } = e as { runId: string; event: DirectorEvent };
      set((s) => {
        const run = s.runs[runId];
        if (!run) return {};
        const events = [...run.events];
        const last = events[events.length - 1];
        if ((event.type === "text" || event.type === "thinking") && last && last.type === event.type) events[events.length - 1] = { ...last, text: last.text + event.text };
        else events.push(event);
        return { runs: { ...s.runs, [runId]: { ...run, events, ...(event.type === "status" ? { status: event.status as DirectorRun["status"] } : {}) } } };
      });
    });
    try {
      await engine.connect();
      const info = await engine.call<AppInfo & { session: SessionState }>("app.info");
      const jobs = await engine.call<JobInfo[]>("jobs.list");
      const runs = await engine.call<DirectorRun[]>("ai.runs");
      set({
        connection: "connected",
        info,
        session: info.session,
        jobs: Object.fromEntries(jobs.map((j) => [j.id, j])),
        runs: Object.fromEntries(runs.map((r) => [r.id, r])),
      });
    } catch (e) {
      set({ connection: "error", connectionError: (e as Error).message });
    }
  },

  async call(method, params = {}) {
    try {
      return await engine.call(method, params);
    } catch (e) {
      const msg = e instanceof EngineError ? e.message : (e as Error).message;
      get().toast("error", msg);
      throw e;
    }
  },

  dispatch(name, params, label) {
    return get().call("project.dispatch", { name, params, label });
  },

  transaction(label, commands) {
    return get().call("project.transaction", { label, commands });
  },

  async undo() {
    await get().call("project.undo");
  },
  async redo() {
    await get().call("project.redo");
  },
  setSelection: (selection) => set({ selection }),
  setPlayhead: (f) => set({ playhead: Math.max(0, Math.round(f)) }),
  setPlaying: (playing) => set({ playing }),
  setZoom: (z) => set({ zoom: Math.min(40, Math.max(0.05, z)) }),
  setWorkspace: (workspace) => set({ workspace, aiPanelOpen: workspace === "ai" ? true : get().aiPanelOpen }),
  setDialog: (dialog) => set({ dialog }),
  toast(kind, text) {
    const id = toastId++;
    set((s) => ({ toasts: [...s.toasts.slice(-4), { id, kind, text }] }));
    setTimeout(() => get().dismissToast(id), kind === "error" ? 8000 : 4500);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  toggleAiPanel: (open) => set((s) => ({ aiPanelOpen: open ?? !s.aiPanelOpen })),
  async updateSettings(patch) {
    const settings = await get().call<AppInfo["settings"]>("app.updateSettings", { patch });
    set((s) => (s.info ? { info: { ...s.info, settings } } : {}));
  },
  set: (partial) => set(partial),
}));

/** Absolute path of a project-relative derived file. */
export function projectFile(rel: string | undefined): string | undefined {
  const dir = useStudio.getState().session.dir;
  if (!rel || !dir) return undefined;
  return `${dir}/${rel}`;
}

export function useProject(): Project | undefined {
  return useStudio((s) => s.session.project);
}
