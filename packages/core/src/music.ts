/**
 * Registry of the procedural music generator (engine media/music.ts): styles, moods and the
 * section kinds of its structure. Shared by the UI, the AI tools and the engine.
 */

export const MUSIC_STYLES = ["synthwave", "cinematic", "techno"] as const;
export type MusicStyle = (typeof MUSIC_STYLES)[number];
export const MUSIC_MOODS = ["dark", "tense", "uplifting"] as const;
export type MusicMood = (typeof MUSIC_MOODS)[number];
export const MUSIC_SECTION_KINDS = ["intro", "build", "drop", "breakdown", "outro"] as const;
export type MusicSectionKind = (typeof MUSIC_SECTION_KINDS)[number];

export const MUSIC_STYLE_SPECS: Record<MusicStyle, { label: string; description: string; bpm: number }> = {
  synthwave: { label: "Synthwave", description: "Retro synth pads, offbeat bass, square arpeggios, four-on-the-floor drops with sidechain pump (arcade / neon / tech teasers).", bpm: 118 },
  cinematic: { label: "Cinematic", description: "Drones, string-like pads, low ostinato, taiko-style toms and brass 'braams' on the drops, ticking builds (trailers, reveals).", bpm: 90 },
  techno: { label: "Techno", description: "Driving kick, claps, open hats, rolling sub bass and chord stabs; minimal and relentless (fast cuts, product spots).", bpm: 128 },
};

export const MUSIC_MOOD_LABELS: Record<MusicMood, string> = {
  dark: "Dark (minor: i–VI–III–VII)",
  tense: "Tense (minor: i–VI–iv–V)",
  uplifting: "Uplifting (major: I–V–vi–IV)",
};
