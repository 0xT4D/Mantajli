import { ChevronDown, ChevronRight, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

export function IconButton({
  icon,
  label,
  shortcut,
  onClick,
  active,
  disabled,
  className,
  size = 28,
}: {
  icon: ReactNode;
  label: string;
  shortcut?: string;
  onClick?: (e: React.MouseEvent) => void;
  active?: boolean;
  disabled?: boolean;
  className?: string;
  size?: number;
}) {
  return (
    <button
      type="button"
      title={shortcut ? `${label} (${shortcut})` : label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      style={{ width: size, height: size }}
      className={cx(
        "inline-flex shrink-0 items-center justify-center rounded text-dim transition-colors",
        "hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-35",
        active && "bg-raised text-accent-2",
        className,
      )}
    >
      {icon}
    </button>
  );
}

export function Button({
  children,
  onClick,
  variant = "default",
  disabled,
  title,
  className,
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "default" | "primary" | "ghost" | "danger";
  disabled?: boolean;
  title?: string;
  className?: string;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cx(
        "inline-flex h-7 items-center gap-1.5 rounded px-2.5 text-[12px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-40",
        variant === "primary" && "bg-accent text-white hover:bg-accent-2",
        variant === "default" && "border border-line-2 bg-raised text-fg hover:bg-hover",
        variant === "ghost" && "text-dim hover:bg-hover hover:text-fg",
        variant === "danger" && "border border-err/40 bg-err/10 text-err hover:bg-err/20",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Section({ title, children, defaultOpen = true, right }: { title: string; children: ReactNode; defaultOpen?: boolean; right?: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-line">
      <div className="flex h-7 items-center gap-1 px-2">
        <button type="button" className="flex flex-1 items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-dim hover:text-fg" onClick={() => setOpen(!open)}>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {title}
        </button>
        {right}
      </div>
      {open && <div className="space-y-1.5 px-3 pb-3">{children}</div>}
    </div>
  );
}

export function Row({ label, children, title }: { label: string; children: ReactNode; title?: string }) {
  return (
    <div className="grid grid-cols-[88px_1fr] items-center gap-2" title={title}>
      <span className="truncate text-[11px] text-dim">{label}</span>
      <div className="flex min-w-0 items-center gap-1">{children}</div>
    </div>
  );
}

/**
 * Numeric field: drag horizontally on the label area to scrub, or type.
 * Commits on blur/Enter (and at the end of a scrub), not on every keystroke.
 */
export function NumberField({
  value,
  onChange,
  min,
  max,
  step = 1,
  unit,
  precision,
  disabled,
  className,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  precision?: number;
  disabled?: boolean;
  className?: string;
}) {
  const p = precision ?? (step >= 1 ? 0 : step >= 0.1 ? 1 : 2);
  const [text, setText] = useState(value.toFixed(p));
  const [editing, setEditing] = useState(false);
  const drag = useRef<{ x: number; v: number; moved: boolean } | null>(null);
  const [preview, setPreview] = useState<number | null>(null);
  useEffect(() => {
    if (!editing) setText(value.toFixed(p));
  }, [value, editing, p]);
  const clamp = (v: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));
  const commit = (v: number) => {
    const c = clamp(Math.round(v / step) * step);
    if (Number.isFinite(c) && c !== value) onChange(Number(c.toFixed(6)));
  };
  return (
    <div className={cx("flex h-6 min-w-0 flex-1 items-center rounded border border-line bg-bg focus-within:border-accent", disabled && "opacity-40", className)}>
      <span
        className="h-full w-2.5 shrink-0 cursor-ew-resize"
        onPointerDown={(e) => {
          if (disabled) return;
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, v: value, moved: false };
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          const dx = e.clientX - drag.current.x;
          if (Math.abs(dx) > 2) drag.current.moved = true;
          const span = (max ?? 100) - (min ?? 0);
          const rate = Number.isFinite(span) && span < 1000 ? span / 300 : step;
          setPreview(clamp(drag.current.v + dx * Math.max(step, rate) * (e.shiftKey ? 0.1 : 1)));
        }}
        onPointerUp={() => {
          if (drag.current?.moved && preview !== null) commit(preview);
          drag.current = null;
          setPreview(null);
        }}
      />
      <input
        className="tabular min-w-0 flex-1 bg-transparent pr-1 text-right text-[11px] outline-none"
        value={preview !== null ? preview.toFixed(p) : text}
        disabled={disabled}
        onFocus={() => setEditing(true)}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          setEditing(false);
          const v = Number(text);
          if (Number.isFinite(v)) commit(v);
          else setText(value.toFixed(p));
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setText(value.toFixed(p));
            (e.target as HTMLInputElement).blur();
          }
          e.stopPropagation();
        }}
      />
      {unit && <span className="pr-1.5 text-[10px] text-mute">{unit}</span>}
    </div>
  );
}

export function Slider({ value, onChange, min, max, step, unit, precision }: { value: number; onChange: (v: number) => void; min: number; max: number; step: number; unit?: string; precision?: number }) {
  const [local, setLocal] = useState<number | null>(null);
  return (
    <>
      <input
        type="range"
        className="min-w-0 flex-1"
        min={min}
        max={max}
        step={step}
        value={local ?? value}
        onChange={(e) => setLocal(Number(e.target.value))}
        onPointerUp={() => {
          if (local !== null) onChange(local);
          setLocal(null);
        }}
        onKeyUp={() => {
          if (local !== null) onChange(local);
          setLocal(null);
        }}
      />
      <NumberField className="max-w-[64px]" value={local ?? value} onChange={onChange} min={min} max={max} step={step} unit={unit} precision={precision} />
    </>
  );
}

export function Select<T extends string>({ value, onChange, options, className }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; className?: string }) {
  return (
    <select
      className={cx("h-6 min-w-0 flex-1 rounded border border-line bg-bg px-1 text-[11px] outline-none focus:border-accent", className)}
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-1.5 text-[11px] text-dim">
      <span className={cx("relative h-3.5 w-6 rounded-full transition-colors", checked ? "bg-accent" : "bg-line-2")} onClick={() => onChange(!checked)}>
        <span className={cx("absolute top-0.5 h-2.5 w-2.5 rounded-full bg-white transition-all", checked ? "left-3" : "left-0.5")} />
      </span>
      {label}
    </label>
  );
}

export function ColorField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex h-6 flex-1 items-center gap-1.5 rounded border border-line bg-bg px-1">
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)} className="h-4 w-5 cursor-pointer border-0 bg-transparent p-0" />
      <span className="tabular text-[11px] text-dim">{value}</span>
    </label>
  );
}

export function TextField({ value, onCommit, placeholder, multiline, className }: { value: string; onCommit: (v: string) => void; placeholder?: string; multiline?: boolean; className?: string }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const common = {
    value: text,
    placeholder,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setText(e.target.value),
    onBlur: () => text !== value && onCommit(text),
    onKeyDown: (e: React.KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === "Enter" && !multiline) (e.target as HTMLElement).blur();
    },
    className: cx("w-full rounded border border-line bg-bg px-1.5 text-[11px] outline-none focus:border-accent", multiline ? "min-h-14 py-1" : "h-6", className),
  };
  return multiline ? <textarea {...common} /> : <input {...common} />;
}

export function Progress({ value, className }: { value: number | null; className?: string }) {
  return (
    <div className={cx("h-1 overflow-hidden rounded bg-line-2", className)}>
      {value === null ? <div className="h-full w-1/3 animate-pulse bg-accent" /> : <div className="h-full bg-accent transition-[width]" style={{ width: `${Math.round(value * 100)}%` }} />}
    </div>
  );
}

export function Dialog({ title, onClose, children, width = 520, footer }: { title: string; onClose: () => void; children: ReactNode; width?: number; footer?: ReactNode }) {
  useEffect(() => {
    // Capture phase: fields inside the dialog stop key propagation, Escape must still close it.
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onMouseDown={onClose}>
      <div role="dialog" aria-modal="true" aria-label={title} className="max-h-[90vh] overflow-hidden rounded-md border border-line-2 bg-panel shadow-2xl" style={{ width }} onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex h-9 items-center border-b border-line px-3">
          <span className="flex-1 text-[13px] font-semibold">{title}</span>
          <IconButton icon={<X size={14} />} label="Close" onClick={onClose} size={24} />
        </div>
        <div className="max-h-[70vh] overflow-auto p-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-line px-3 py-2">{footer}</div>}
      </div>
    </div>
  );
}

export function Empty({ icon, title, hint, action }: { icon?: ReactNode; title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      {icon && <div className="text-mute">{icon}</div>}
      <div className="text-[12px] font-medium text-dim">{title}</div>
      {hint && <div className="max-w-64 text-[11px] text-mute">{hint}</div>}
      {action}
    </div>
  );
}

export function PanelHeader({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex h-8 shrink-0 items-center gap-1 border-b border-line bg-panel px-2">
      <div className="flex-1 truncate text-[11px] font-semibold uppercase tracking-wide text-dim">{title}</div>
      {children}
    </div>
  );
}
