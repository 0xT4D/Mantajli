import { describe, expect, it } from "vitest";
import { captionLook, formatSrt, parseSubtitles } from "../src/index.js";

const SRT = `﻿1
00:00:01,000 --> 00:00:02,500
Hello <i>world</i>

2
00:00:02,500 --> 00:00:04,000 X1:0
{\\an8}Second line
two

3
broken --> nonsense

4
00:00:05,000 --> 00:00:04,000
end before start
`;

const VTT = `WEBVTT

NOTE a comment

intro
00:01.000 --> 00:02.000 align:center
<v Speaker>Short form</v>

00:00:03.250 --> 00:00:04.000
Done
`;

describe("subtitles", () => {
  it("parses SRT with markup and skips malformed cues", () => {
    expect(parseSubtitles(SRT)).toEqual([
      { start: 1, end: 2.5, text: "Hello world" },
      { start: 2.5, end: 4, text: "Second line\ntwo" },
    ]);
  });

  it("parses WebVTT with short timestamps, ids and settings", () => {
    expect(parseSubtitles(VTT)).toEqual([
      { start: 1, end: 2, text: "Short form" },
      { start: 3.25, end: 4, text: "Done" },
    ]);
  });

  it("writes SRT that parses back to the same cues", () => {
    const cues = [
      { start: 0.04, end: 1.5, text: "A" },
      { start: 3661.007, end: 3662, text: "B\nC" },
    ];
    expect(formatSrt(cues)).toContain("01:01:01,007 --> 01:01:02,000");
    expect(parseSubtitles(formatSrt(cues))).toEqual(cues);
  });

  it("sizes caption looks to the frame and keeps vertical captions above the UI", () => {
    const v = captionLook("bold", "bottom", 1080, 1920);
    const h = captionLook("bold", "bottom", 1920, 1080);
    expect(v.style.fontSize).toBe(h.style.fontSize);
    expect(v.y).toBeGreaterThan(0);
    expect(v.y).toBeLessThan(1920 * 0.25);
    expect(captionLook("boxed", "top", 1920, 1080)).toMatchObject({ style: { box: true }, y: expect.any(Number) });
    expect(captionLook("clean", "top", 1920, 1080).y).toBeLessThan(0);
  });
});
