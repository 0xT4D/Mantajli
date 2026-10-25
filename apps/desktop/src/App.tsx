import { Loader2, PlugZap } from "lucide-react";
import { AutoEditDialog } from "./components/AutoEdit";
import { MusicDialog, SoundDesignDialog, VoiceDialog } from "./components/Generate";
import { useEffect } from "react";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import { clipEnd, projectDuration, type Clip } from "@mantagli/core";
import { AIPanel } from "./components/AIPanel";
import { ExportDialog, NewProjectDialog, OpenProjectDialog, SettingsDialog, StatusBar, Toasts, TopBar, Welcome } from "./components/Chrome";
import { Inspector } from "./components/Inspector";
import { importFlow, importPaths, MediaBrowser } from "./components/MediaBrowser";
import { Timeline } from "./components/Timeline";
import { Button } from "./components/ui";
import { Viewer } from "./components/Viewer";
import { useBinDrag } from "./lib/binDrag";
import { onFileDrop } from "./lib/platform";
import { useStudio } from "./store/studio";

export function App() {
  const { connection, connectionError, session, dialog, init } = useStudio();

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    let un: (() => void) | undefined;
    void onFileDrop((paths) => {
      if (useStudio.getState().session.open) void importPaths(paths);
    }).then((f) => (un = f));
    return () => un?.();
  }, []);

  useShortcuts();

  if (connection === "connecting") {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-dim">
        <Loader2 size={16} className="animate-spin" /> Starting engine…
      </div>
    );
  }
  if (connection === "error") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <PlugZap size={28} className="text-err" />
        <div className="text-[13px] font-medium">Could not reach the Mantagli engine</div>
        <div className="max-w-md text-[11px] text-dim">{connectionError}</div>
        <Button onClick={() => location.reload()}>Retry</Button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <TopBar />
      <div className="min-h-0 flex-1">{session.open && session.project ? <Workspace /> : <Welcome />}</div>
      <StatusBar />
      {dialog === "newProject" && <NewProjectDialog />}
      {dialog === "openProject" && <OpenProjectDialog />}
      {dialog === "export" && session.project && <ExportDialog />}
      {dialog === "settings" && <SettingsDialog />}
      {dialog === "autoEdit" && session.project && <AutoEditDialog />}
      {dialog === "music" && session.project && <MusicDialog />}
      {dialog === "voice" && session.project && <VoiceDialog />}
      {dialog === "soundDesign" && session.project && <SoundDesignDialog />}
      <Toasts />
      <DragGhost />
    </div>
  );
}

function DragGhost() {
  const { payload, x, y } = useBinDrag();
  if (!payload) return null;
  return (
    <div className="pointer-events-none fixed z-[70] rounded border border-accent bg-raised/90 px-2 py-1 text-[11px] shadow-xl" style={{ left: x + 12, top: y + 8 }}>
      {payload.label}
    </div>
  );
}

function Workspace() {
  const workspace = useStudio((s) => s.workspace);
  const aiOpen = useStudio((s) => s.aiPanelOpen);
  const outer = useDefaultLayout({ id: `mantagli-outer-${aiOpen ? "ai" : "noai"}`, storage: localStorage });
  const center = useDefaultLayout({ id: "mantagli-center", storage: localStorage });
  return (
    <Group key={aiOpen ? "ai" : "noai"} orientation="horizontal" defaultLayout={outer.defaultLayout} onLayoutChanged={outer.onLayoutChanged}>
      <Panel id="media" defaultSize="19" minSize="12">
        <MediaBrowser key={workspace} initialTab={workspace === "3d" ? "scenes" : workspace === "color" ? "looks" : "media"} />
      </Panel>
      <Separator className="w-px" />
      <Panel id="center" defaultSize={aiOpen ? "45" : "63"} minSize="30">
        <Group orientation="vertical" defaultLayout={center.defaultLayout} onLayoutChanged={center.onLayoutChanged}>
          <Panel id="viewer" defaultSize="58" minSize="20">
            <Viewer />
          </Panel>
          <Separator className="h-px" />
          <Panel id="timeline" defaultSize="42" minSize="15">
            <Timeline />
          </Panel>
        </Group>
      </Panel>
      <Separator className="w-px" />
      <Panel id="inspector" defaultSize="18" minSize="13">
        <Inspector />
      </Panel>
      {aiOpen && (
        <>
          <Separator className="w-px" />
          <Panel id="ai" defaultSize="18" minSize="14">
            <AIPanel />
          </Panel>
        </>
      )}
    </Group>
  );
}

function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
}

/** Clips copied with Ctrl+C / Ctrl+X (with their source tracks), pasted with Ctrl+V. */
let clipboard: { trackId: string; clip: Clip }[] = [];

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      const st = useStudio.getState();
      const p = st.session.project;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && key === "o") {
        e.preventDefault();
        st.setDialog("openProject");
        return;
      }
      if (mod && key === "n") {
        e.preventDefault();
        st.setDialog("newProject");
        return;
      }
      if (!p) return;
      const total = projectDuration(p);
      const sel = st.selection.kind === "clips" ? st.selection.ids : [];
      const allClips = p.tracks.flatMap((tr) => tr.clips);
      if (mod) {
        if (key === "z" && !e.shiftKey) void st.undo().catch(() => {});
        else if ((key === "z" && e.shiftKey) || key === "y") void st.redo().catch(() => {});
        else if (key === "s") void st.call("project.save").then(() => st.toast("ok", "Saved with backup")).catch(() => {});
        else if (key === "e") st.setDialog("export");
        else if (key === "i") void importFlow();
        else if (key === "d" && sel.length) void st.transaction("Duplicate", sel.map((id) => ({ name: "clip.duplicate", params: { clipId: id } }))).catch(() => {});
        else if ((key === "c" || key === "x") && sel.length) {
          // Copy (or cut) the selected clips with their tracks; Ctrl+V pastes them at the playhead.
          clipboard = p.tracks.flatMap((tr) => tr.clips.filter((c) => sel.includes(c.id)).map((clip) => ({ trackId: tr.id, clip })));
          if (key === "x") void st.dispatch("clip.remove", { clipIds: sel }, "Cut").then(() => st.setSelection({ kind: "none" })).catch(() => {});
          else st.toast("info", `Copied ${clipboard.length} clip${clipboard.length > 1 ? "s" : ""}`);
        } else if (key === "v" && clipboard.length)
          void st
            .dispatch("clip.paste", { items: clipboard, at: st.playhead }, "Paste")
            .then((r) => st.setSelection({ kind: "clips", ids: (r as { clipIds: string[] }).clipIds }))
            .catch(() => {});
        else if (key === "a") st.setSelection({ kind: "clips", ids: allClips.map((c) => c.id) });
        else return;
        e.preventDefault();
        return;
      }
      switch (e.key) {
        case " ":
          e.preventDefault();
          st.setPlaying(!st.playing);
          return;
        case "ArrowLeft":
          e.preventDefault();
          st.setPlayhead(st.playhead - (e.shiftKey ? 10 : 1));
          return;
        case "ArrowRight":
          e.preventDefault();
          st.setPlayhead(Math.min(total - 1, st.playhead + (e.shiftKey ? 10 : 1)));
          return;
        case "Home":
          st.setPlayhead(0);
          return;
        case "End":
          st.setPlayhead(total - 1);
          return;
        case "Delete":
        case "Backspace":
          if (sel.length) void st.dispatch("clip.remove", { clipIds: sel, ripple: e.shiftKey }, e.shiftKey ? "Ripple delete" : "Delete").then(() => st.setSelection({ kind: "none" })).catch(() => {});
          else if (st.selection.kind === "marker") void st.dispatch("marker.remove", { markerIds: [st.selection.id] }, "Delete marker").catch(() => {});
          return;
        case "Escape":
          st.setSelection({ kind: "none" });
          return;
        case "+":
        case "=":
          st.setZoom(st.zoom * 1.4);
          return;
        case "-":
          st.setZoom(st.zoom / 1.4);
          return;
      }
      if (key === "s") {
        const ids = (sel.length ? sel : allClips.map((c) => c.id)).filter((id) => {
          const c = allClips.find((x) => x.id === id);
          return c && c.start < st.playhead && clipEnd(c) > st.playhead;
        });
        if (ids.length) void st.transaction("Split", ids.map((id) => ({ name: "clip.split", params: { clipId: id, frame: st.playhead } }))).catch(() => {});
      } else if (key === "m") void st.dispatch("marker.add", { frame: st.playhead, kind: "cue", label: "" }, "Add marker").catch(() => {});
      else if (key === "n") st.set({ snapping: !st.snapping });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
