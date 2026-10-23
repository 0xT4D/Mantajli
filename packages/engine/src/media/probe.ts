import path from "node:path";
import { fail, parseRational, type AssetKind, type MediaMeta } from "@mantagli/core";
import { run } from "../util/proc.js";

const EXT_KIND: Record<string, AssetKind> = {
  ".mp4": "video", ".mov": "video", ".m4v": "video", ".mkv": "video", ".webm": "video", ".avi": "video", ".mxf": "video",
  ".wav": "audio", ".mp3": "audio", ".aac": "audio", ".m4a": "audio", ".flac": "audio", ".ogg": "audio", ".opus": "audio", ".aif": "audio", ".aiff": "audio",
  ".png": "image", ".jpg": "image", ".jpeg": "image", ".webp": "image", ".bmp": "image", ".tif": "image", ".tiff": "image", ".gif": "image", ".exr": "image",
  ".glb": "model", ".gltf": "model", ".obj": "model", ".fbx": "model", ".stl": "model", ".ply": "model",
  ".ttf": "font", ".otf": "font",
  ".cube": "lut", ".3dl": "lut",
};

export const SUPPORTED_EXTENSIONS = Object.keys(EXT_KIND);

export function kindFromExtension(file: string): AssetKind | undefined {
  return EXT_KIND[path.extname(file).toLowerCase()];
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  pix_fmt?: string;
  sample_rate?: string;
  channels?: number;
  duration?: string;
  nb_frames?: string;
  disposition?: { attached_pic?: number };
  side_data_list?: { rotation?: number }[];
  tags?: { rotate?: string };
}

/** Inspect a media file with ffprobe. Reads headers only, never the full file. */
export async function probeMedia(ffprobe: string, file: string, kindHint?: AssetKind): Promise<{ kind: AssetKind; meta: MediaMeta }> {
  const r = await run(ffprobe, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], { timeoutMs: 60000 });
  if (r.code !== 0) fail("invalid_params", `Not a readable media file: ${r.stderr.trim().split("\n").pop() ?? "ffprobe failed"}`);
  const data = JSON.parse(r.stdout) as { streams?: FfprobeStream[]; format?: { format_name?: string; duration?: string; bit_rate?: string } };
  const streams = data.streams ?? [];
  const v = streams.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  const a = streams.find((s) => s.codec_type === "audio");
  const fmtDuration = Number(data.format?.duration);
  const meta: MediaMeta = {
    formatName: data.format?.format_name,
    hasVideo: !!v,
    hasAudio: !!a,
  };
  if (Number.isFinite(fmtDuration) && fmtDuration > 0) meta.duration = fmtDuration;
  if (data.format?.bit_rate) meta.bitRate = Number(data.format.bit_rate);
  if (v) {
    meta.videoCodec = v.codec_name;
    meta.pixFmt = v.pix_fmt;
    const rotation = v.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? (v.tags?.rotate ? Number(v.tags.rotate) : 0);
    meta.rotation = rotation;
    // ffmpeg auto-rotates on decode, so report display dimensions.
    const swap = Math.abs(rotation) % 180 === 90;
    if (v.width && v.height) {
      meta.width = swap ? v.height : v.width;
      meta.height = swap ? v.width : v.height;
    }
    const rf = v.r_frame_rate ? parseRational(v.r_frame_rate) : null;
    const af = v.avg_frame_rate && v.avg_frame_rate !== "0/0" ? parseRational(v.avg_frame_rate) : null;
    const fps = af ?? rf;
    if (fps && fps.num > 0) meta.fps = fps;
    if (rf && af) meta.variableFrameRate = Math.abs(rf.num / rf.den - af.num / af.den) > 0.05;
  }
  if (a) {
    meta.audioCodec = a.codec_name;
    if (a.sample_rate) meta.sampleRate = Number(a.sample_rate);
    if (a.channels) meta.channels = a.channels;
  }
  const extKind = kindFromExtension(file);
  let kind: AssetKind;
  if (kindHint) kind = kindHint;
  else if (extKind === "image" || (v && !a && (meta.duration === undefined || meta.duration < 0.05 || v.codec_name === "png" || v.codec_name === "mjpeg") && extKind !== "video")) kind = "image";
  else if (v) kind = "video";
  else if (a) kind = "audio";
  else fail("unsupported", "File has no video or audio streams");
  if (kind === "image") {
    delete meta.duration;
    meta.hasAudio = false;
  }
  if ((kind === "video" || kind === "audio") && !meta.duration) fail("unsupported", "Could not determine media duration");
  return { kind, meta };
}
