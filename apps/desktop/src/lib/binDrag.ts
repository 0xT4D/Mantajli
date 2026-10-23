import { create } from "zustand";

/**
 * Pointer-based drag from the media bin to the timeline.
 *
 * HTML5 drag-and-drop is unreliable inside the Windows webview while native
 * OS file drops are enabled, so the bin uses pointer events and a global
 * drop event instead.
 */

export interface BinPayload {
  kind: "asset" | "scene";
  id: string;
  label: string;
}

interface BinDragState {
  payload: BinPayload | null;
  x: number;
  y: number;
}

export const useBinDrag = create<BinDragState>(() => ({ payload: null, x: 0, y: 0 }));

export const BIN_DROP_EVENT = "mantagli-bin-drop";
export interface BinDropDetail {
  payload: BinPayload;
  x: number;
  y: number;
}

/** Spread onto a bin item to make it draggable onto the timeline. */
export function binDragHandlers(payload: BinPayload) {
  return {
    onPointerDown(e: React.PointerEvent) {
      if (e.button !== 0) return;
      const sx = e.clientX;
      const sy = e.clientY;
      let active = false;
      const move = (ev: PointerEvent) => {
        if (!active && Math.hypot(ev.clientX - sx, ev.clientY - sy) > 5) active = true;
        if (active) useBinDrag.setState({ payload, x: ev.clientX, y: ev.clientY });
      };
      const up = (ev: PointerEvent) => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        if (active) window.dispatchEvent(new CustomEvent<BinDropDetail>(BIN_DROP_EVENT, { detail: { payload, x: ev.clientX, y: ev.clientY } }));
        useBinDrag.setState({ payload: null });
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
  };
}
