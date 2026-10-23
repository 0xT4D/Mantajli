import { Bot, Brain, Check, ChevronDown, ChevronRight, CircleAlert, ListChecks, RotateCcw, Send, Square, Wrench, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { engine } from "../engine/client";
import { useStudio, type DirectorEvent, type DirectorRun } from "../store/studio";
import { Button, cx, Empty, IconButton, PanelHeader, Toggle } from "./ui";

const EXAMPLES = [
  "Create a 20-second vertical cinematic montage from my footage and music. Slow intro, then cut on the beat. Add a 3D chrome title at the start, teal & orange grade, and a strong final shot.",
  "Analyse the music and re-cut the existing clips so every cut lands on a downbeat.",
  "Add an animated title 'NIGHT CITY' over the first 3 seconds with a pop-in, then preview it.",
];

export function AIPanel() {
  const { runs, info, call, toggleAiPanel } = useStudio();
  const project = useStudio((s) => s.session.project);
  const [brief, setBrief] = useState("");
  const [keyInput, setKeyInput] = useState("");
  const autonomy = info?.settings.aiAutonomy ?? "review";
  const list = Object.values(runs).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const active = list.find((r) => r.status === "running" || r.status === "awaiting_approval");
  const hasKey = info?.ai.hasKey;
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastPlan = project?.ai.plans[project.ai.plans.length - 1];

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [runs]);

  const start = async () => {
    if (!brief.trim()) return;
    const r = await call<DirectorRun>("ai.start", { brief: brief.trim(), autonomy }).catch(() => null);
    if (r) {
      useStudio.setState((s) => ({ runs: { ...s.runs, [r.id]: r } }));
      setBrief("");
    }
  };

  const saveKey = async () => {
    const { saveApiKey } = await import("../lib/platform");
    const where = await saveApiKey(keyInput.trim());
    await call("ai.setApiKey", { key: keyInput.trim() });
    useStudio.setState((s) => (s.info ? { info: { ...s.info, ai: { ...s.info.ai, hasKey: true } } } : {}));
    setKeyInput("");
    useStudio.getState().toast("ok", where === "keychain" ? "API key saved to the system keychain" : "API key set for this session (browser dev mode does not persist it)");
  };

  return (
    <div className="flex h-full flex-col bg-panel">
      <PanelHeader
        title={
          <span className="flex items-center gap-1.5">
            <Bot size={13} className="text-accent-2" /> AI Director
          </span>
        }
      >
        <Toggle checked={autonomy === "autonomous"} onChange={(v) => void useStudio.getState().updateSettings({ aiAutonomy: v ? "autonomous" : "review" })} label={autonomy === "autonomous" ? "Autonomous" : "Review"} />
        <IconButton icon={<RotateCcw size={13} />} label="New conversation (forget previous briefs)" onClick={() => void call("ai.reset").then(() => useStudio.getState().toast("info", "Started a new AI conversation"))} />
        <IconButton icon={<X size={13} />} label="Hide AI panel" onClick={() => toggleAiPanel(false)} />
      </PanelHeader>

      {!hasKey && (
        <div className="m-2 space-y-1.5 rounded border border-warn/40 bg-warn/10 p-2 text-[11px]">
          <div className="font-medium text-warn">Anthropic API key required</div>
          <div className="text-dim">The Director calls Claude ({info?.ai.model}). Your key is stored in the OS keychain, never in project files or logs. Alternatively connect Claude Code through the MCP server.</div>
          <div className="flex gap-1">
            <input type="password" className="h-6 min-w-0 flex-1 rounded border border-line bg-bg px-1.5 text-[11px] outline-none" placeholder="sk-ant-…" value={keyInput} onChange={(e) => setKeyInput(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
            <Button variant="primary" disabled={!keyInput.trim()} onClick={() => void saveKey()}>
              Save
            </Button>
          </div>
        </div>
      )}

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto p-2">
        {list.length === 0 ? (
          <Empty
            icon={<Bot size={28} />}
            title="Describe the edit you want"
            hint="The Director inspects your project, analyses music, plans shots, edits the real timeline, builds 3D scenes, previews frames and revises. Everything stays editable and undoable."
            action={
              <div className="mt-2 w-full space-y-1">
                {EXAMPLES.map((e) => (
                  <button key={e} type="button" onClick={() => setBrief(e)} className="block w-full rounded border border-line bg-panel-2 px-2 py-1.5 text-left text-[11px] text-dim hover:border-accent hover:text-fg">
                    {e}
                  </button>
                ))}
              </div>
            }
          />
        ) : (
          list.map((r) => <RunView key={r.id} run={r} />)
        )}
        {lastPlan && <PlanView plan={lastPlan} />}
      </div>

      <div className="shrink-0 border-t border-line p-2">
        <textarea
          className="h-20 w-full resize-none rounded border border-line bg-bg p-2 text-[12px] outline-none focus:border-accent"
          placeholder={active ? "The Director is working…" : "Creative brief, e.g. “30s vertical cyberpunk montage cut to the beat…”"}
          value={brief}
          disabled={!!active}
          onChange={(e) => setBrief(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void start();
          }}
        />
        <div className="mt-1 flex items-center gap-1">
          <span className="flex-1 text-[10px] text-mute">{autonomy === "review" ? "Review mode: exports and large deletions ask first." : "Autonomous: the Director applies changes without asking."}</span>
          {active ? (
            <Button variant="danger" onClick={() => void call("ai.cancel", { runId: active.id })}>
              <Square size={11} /> Stop
            </Button>
          ) : (
            <Button variant="primary" disabled={!brief.trim() || !hasKey} onClick={() => void start()} title="Run (Ctrl+Enter)">
              <Send size={12} /> Direct
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function RunView({ run }: { run: DirectorRun }) {
  const { call } = useStudio();
  const statusCls =
    run.status === "done" ? "text-ok" : run.status === "failed" ? "text-err" : run.status === "cancelled" ? "text-mute" : run.status === "awaiting_approval" ? "text-warn" : "text-accent-2";
  const finished = !(run.status === "running" || run.status === "awaiting_approval");
  return (
    <div className="mb-3 rounded border border-line bg-panel-2">
      <div className="border-b border-line px-2 py-1.5">
        <div className="text-[11px] font-medium text-fg">{run.brief}</div>
        <div className="mt-0.5 flex items-center gap-2 text-[10px]">
          <span className={statusCls}>{run.status.replace("_", " ")}</span>
          <span className="text-mute">{run.steps} steps</span>
          {run.usage.outputTokens > 0 && <span className="text-mute">{Math.round((run.usage.inputTokens + run.usage.outputTokens) / 1000)}k tokens</span>}
          {run.decision && <span className={run.decision === "accepted" ? "text-ok" : "text-warn"}>{run.decision}</span>}
        </div>
      </div>
      <div className="space-y-1 p-2">
        {run.events.map((e, i) => (
          <EventView key={i} e={e} run={run} />
        ))}
        {(run.status === "running" || run.status === "awaiting_approval") && <div className="h-1 w-full animate-pulse rounded bg-accent/40" />}
      </div>
      {finished && run.changed && !run.decision && (
        <div className="flex items-center gap-1 border-t border-line px-2 py-1.5">
          <span className="flex-1 text-[10px] text-dim">Keep the Director's changes?</span>
          <Button onClick={() => void call("ai.revert", { runId: run.id })} title="Restore the project as it was before this brief (undoable)">
            <RotateCcw size={11} /> Revert all
          </Button>
          <Button variant="primary" onClick={() => void call("ai.accept", { runId: run.id })}>
            <Check size={11} /> Accept
          </Button>
        </div>
      )}
    </div>
  );
}

function EventView({ e, run }: { e: DirectorEvent; run: DirectorRun }) {
  const [open, setOpen] = useState(false);
  const { call } = useStudio();
  switch (e.type) {
    case "text":
      return <div className="whitespace-pre-wrap text-[12px] leading-relaxed text-fg">{e.text}</div>;
    case "thinking":
      return (
        <button type="button" className="flex w-full items-start gap-1 text-left text-[11px] text-mute" onClick={() => setOpen(!open)}>
          <Brain size={11} className="mt-0.5 shrink-0" />
          <span className={cx("whitespace-pre-wrap", !open && "line-clamp-1")}>{e.text || "Thinking…"}</span>
        </button>
      );
    case "tool_call": {
      const result = run.events.find((x): x is Extract<DirectorEvent, { type: "tool_result" }> => x.type === "tool_result" && x.callId === e.callId);
      return (
        <div className="rounded border border-line bg-bg">
          <button type="button" className="flex h-6 w-full items-center gap-1 px-1.5 text-[11px]" onClick={() => setOpen(!open)}>
            {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            <Wrench size={11} className="text-mute" />
            <span className="font-mono text-dim">{e.name}</span>
            <span className="flex-1" />
            {!result ? <span className="text-accent-2">running…</span> : result.ok ? <Check size={11} className="text-ok" /> : <CircleAlert size={11} className="text-err" />}
          </button>
          {result?.error && <div className="px-2 pb-1 text-[10px] text-err">{result.error}</div>}
          {result?.images?.length ? (
            <div className="flex gap-1 overflow-x-auto px-1.5 pb-1.5">
              {result.images.map((p) => (
                <img key={p} src={engine.fileUrl(p)} alt="" className="h-20 rounded border border-line" title="Rendered preview the Director reviewed" />
              ))}
            </div>
          ) : null}
          {open && (
            <div className="space-y-1 border-t border-line p-1.5 font-mono text-[10px] text-dim">
              <div className="max-h-40 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(e.input, null, 1)}</div>
              {result && <div className="max-h-40 overflow-auto border-t border-line pt-1 whitespace-pre-wrap break-all">{result.summary}</div>}
            </div>
          )}
        </div>
      );
    }
    case "tool_result":
      return null;
    case "approval_request": {
      const resolved = run.events.some((x) => x.type === "approval_resolved" && x.approvalId === e.approvalId);
      return (
        <div className="rounded border border-warn/50 bg-warn/10 p-2 text-[11px]">
          <div className="font-medium text-warn">Approval needed: {e.tool}</div>
          <div className="text-dim">{e.summary}</div>
          {!resolved && (
            <div className="mt-1 flex gap-1">
              <Button variant="primary" onClick={() => void call("ai.approve", { approvalId: e.approvalId, approved: true })}>
                Approve
              </Button>
              <Button onClick={() => void call("ai.approve", { approvalId: e.approvalId, approved: false })}>Decline</Button>
            </div>
          )}
        </div>
      );
    }
    case "approval_resolved":
      return <div className={cx("text-[10px]", e.approved ? "text-ok" : "text-mute")}>{e.approved ? "Approved" : "Declined"}</div>;
    case "error":
      return <div className="rounded border border-err/40 bg-err/10 p-1.5 text-[11px] text-err">{e.message}</div>;
    case "status":
      return null;
  }
}

function PlanView({ plan }: { plan: NonNullable<ReturnType<typeof useStudio.getState>["session"]["project"]>["ai"]["plans"][number] }) {
  const [open, setOpen] = useState(false);
  const setPlayhead = useStudio((s) => s.setPlayhead);
  return (
    <div className="rounded border border-line bg-panel-2">
      <button type="button" className="flex h-7 w-full items-center gap-1.5 px-2 text-[11px]" onClick={() => setOpen(!open)}>
        <ListChecks size={12} className="text-accent-2" />
        <span className="flex-1 truncate text-left font-medium">Edit plan · {plan.shots.length} shots</span>
        <span className="text-[10px] text-mute">{plan.status}</span>
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
      </button>
      {open && (
        <div className="space-y-1 border-t border-line p-2">
          {plan.summary && <div className="text-[11px] text-dim">{plan.summary}</div>}
          {plan.shots.map((s) => (
            <button key={s.index} type="button" onClick={() => setPlayhead(s.startFrame)} className="flex w-full gap-2 rounded px-1 py-0.5 text-left text-[11px] hover:bg-hover">
              <span className="tabular w-14 shrink-0 font-mono text-mute">{s.startFrame}f</span>
              <span className="min-w-0 flex-1">
                {s.description}
                {s.transition && <span className="text-mute"> · {s.transition}</span>}
              </span>
              <span className="tabular shrink-0 text-mute">{s.durationFrames}f</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
