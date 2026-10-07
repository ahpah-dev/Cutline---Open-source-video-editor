import assert from "node:assert/strict";
import test from "node:test";
import { audioLevels, audioTiming, audioWindow } from "../app/editor/codexMediaData";
import { makeClip, type Asset } from "../app/editor/model";
import { CODEX_TOOLS, validate } from "../app/editor/codexEditing";
const asset: Asset = { id: "song", name: "Song.wav", kind: "audio", duration: 300, sizeLabel: "test", theme: "audio" };
test("AI audio windows respect trim, speed, source and timeline clocks", () => {
  const clip = { ...makeClip(asset, 10), sourceStart: 4, sourceEnd: 44, speed: 2 };
  const selected = audioWindow(clip, 3, 5);
  assert.equal(selected.start, 13); assert.equal(selected.sourceStart, 10); assert.equal(selected.sourceEnd, 20);
  assert.deepEqual(audioTiming(selected, 1.5), { windowSeconds: 1.5, timelineSeconds: 14.5, sourceSeconds: 13 });
  assert.equal(audioWindow(clip, 18, 10).sourceEnd, 44);
  assert.deepEqual(audioTiming(selected, 99), { windowSeconds: 5, timelineSeconds: 18, sourceSeconds: 20 });
  for (const [offset, duration] of [[-1, 5], [20, 5], [0, 121], [0, .1], [19.9, 5], [NaN, 1], [0, Infinity]]) assert.throws(() => audioWindow(clip, offset, duration));
  assert.equal(clip.sourceStart, 4);
});
test("AI source audio levels are real measurements, with bounded silence intervals", () => {
  const silent = audioLevels(new Float32Array(16000));
  assert.equal(silent.rmsDbFS, null); assert.equal(silent.peakDbFS, null); assert.deepEqual(silent.silence, [{ start: 0, end: 1 }]);
  const samples = new Float32Array(32000); samples.fill(.5, 8000, 24000);
  const result = audioLevels(samples);
  assert.equal(result.peakDbFS, -6); assert.equal(result.rmsDbFS, -9);
  assert.deepEqual(result.silence, [{ start: 0, end: .5 }, { start: 1.5, end: 2 }]);
  samples.fill(1); assert.equal(audioLevels(samples).clippedSamplePercent, 100);
  samples.fill(NaN); assert.equal(audioLevels(samples).rmsDbFS, null);
});
test("AI media tools validate duration/mode and do not accept URLs or arbitrary file paths", () => {
  const audio = CODEX_TOOLS.find(tool => tool.name === "cutline_analyze_audio")!.inputSchema;
  const image = CODEX_TOOLS.find(tool => tool.name === "cutline_view_source")!.inputSchema;
  validate({ clipId: "song", mode: "rhythm", duration: 120 }, audio);
  validate({ assetId: "image", sourceTime: 0 }, image);
  for (const args of [{ clipId: "song", mode: "hear" }, { clipId: "song", mode: "speech", duration: 121 }, { clipId: "song", mode: "rhythm", offset: -1 }, { clipId: "song", mode: "rhythm", path: "C:/secret" }]) assert.throws(() => validate(args, audio));
  assert.throws(() => validate({ assetId: "image", url: "https://example.org/secret" }, image));
});
