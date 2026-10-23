/**
 * Platform bridge: native features through Tauri when running in the desktop
 * shell, honest fallbacks in a plain browser (dev mode).
 */
export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface EngineConnection {
  port: number;
  token: string;
}

export async function getEngineConnection(): Promise<EngineConnection> {
  if (isTauri) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<EngineConnection>("engine_connection");
  }
  const qs = new URLSearchParams(location.search);
  if (qs.get("port") && qs.get("token")) return { port: Number(qs.get("port")), token: qs.get("token")! };
  const r = await fetch("/__engine");
  if (!r.ok) throw new Error("No running engine found. Start it with `npm run engine`.");
  return (await r.json()) as EngineConnection;
}

export const MEDIA_FILTERS = [
  { name: "Media", extensions: ["mp4", "mov", "m4v", "mkv", "webm", "avi", "wav", "mp3", "m4a", "aac", "flac", "ogg", "png", "jpg", "jpeg", "webp", "tif", "tiff", "gif", "glb", "gltf", "obj", "fbx", "stl", "ply", "ttf", "otf", "cube", "3dl"] },
];

/** Native file picker. Returns null when unavailable (browser dev mode). */
export async function pickFiles(opts: { multiple?: boolean; directory?: boolean; filters?: { name: string; extensions: string[] }[]; title?: string } = {}): Promise<string[] | null> {
  if (!isTauri) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const r = await open({ multiple: opts.multiple ?? false, directory: opts.directory ?? false, filters: opts.filters, title: opts.title });
  if (r === null) return [];
  return Array.isArray(r) ? r : [r];
}

export async function pickSavePath(opts: { defaultPath?: string; filters?: { name: string; extensions: string[] }[] }): Promise<string | null | undefined> {
  if (!isTauri) return undefined;
  const { save } = await import("@tauri-apps/plugin-dialog");
  return save({ defaultPath: opts.defaultPath, filters: opts.filters });
}

/** Subscribe to OS file drops (desktop only). */
export async function onFileDrop(cb: (paths: string[], position: { x: number; y: number }) => void): Promise<() => void> {
  if (!isTauri) return () => {};
  const { getCurrentWebview } = await import("@tauri-apps/api/webview");
  return getCurrentWebview().onDragDropEvent((e) => {
    if (e.payload.type === "drop") cb(e.payload.paths, e.payload.position);
  });
}

export async function revealInFolder(path: string): Promise<boolean> {
  if (!isTauri) return false;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("reveal_path", { path });
  return true;
}

/** API key storage: OS keychain in the desktop app; memory-only in the browser. */
export async function saveApiKey(key: string): Promise<"keychain" | "memory"> {
  if (isTauri) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("set_api_key", { key });
    return "keychain";
  }
  return "memory";
}
