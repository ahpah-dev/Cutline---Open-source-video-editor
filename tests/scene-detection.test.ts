import assert from "node:assert/strict";
import test from "node:test";
import { applySceneCuts, DEFAULT_SCENE_SETTINGS, findSceneCuts, sceneDifference, sceneFingerprint, sceneSourceKey } from "../app/editor/sceneDetection";
import { animatedItem, clipDuration, endOf, makeClip, migrateProject, newProject, type Asset } from "../app/editor/model";
import { editingCatalog, projectSnapshot } from "../app/editor/codexEditing";
import { historyReducer } from "../app/editor/useProject";

function frame(time: number, color: number[]) {
  const pixels = new Uint8ClampedArray(32 * 18 * 4);
  for (let i = 0; i < pixels.length; i += 4) pixels.set([...color, 255], i);
  return sceneFingerprint(pixels, 32, 18, time);
}
const red = [255, 0, 0], blue = [0, 0, 255];
const frames = (color: (time: number) => number[]) => Array.from({ length: 41 }, (_, i) => frame(i / 8, color(i / 8)));
test("scene detection finds abrupt sustained changes, not constant footage", () => {
  const cuts = findSceneCuts(frames(time => time < 2 ? red : blue), DEFAULT_SCENE_SETTINGS);
  assert.deepEqual(cuts.map(cut => cut.time), [2]);
  assert.ok(cuts[0].strength > .6);
  assert.deepEqual(findSceneCuts(frames(() => red), DEFAULT_SCENE_SETTINGS), []);
  assert.equal(sceneDifference(frame(0, red), frame(1, red)), 0);
});
test("scene detection rejects isolated flashes on both their entrance and exit", () => {
  assert.deepEqual(findSceneCuts(frames(time => time === 2 ? [255, 255, 255] : red), DEFAULT_SCENE_SETTINGS), []);
});
test("scene detection rejects gradual color changes and respects sensitivity", () => {
  assert.deepEqual(findSceneCuts(frames(time => [255 - time * 40, 0, time * 40]), DEFAULT_SCENE_SETTINGS), []);
  const subtle = frames(time => time < 2 ? [60, 60, 60] : [92, 92, 92]);
  assert.equal(findSceneCuts(subtle, { sensitivity: 0, minimum: .5 }).length, 0);
  assert.equal(findSceneCuts(subtle, { sensitivity: 100, minimum: .5 }).length, 1);
});
test("scene detection minimum shot length suppresses closely spaced cuts and edge slivers", () => {
  const source = frames(time => time < .125 ? red : time < 2 ? blue : time < 2.25 ? red : blue);
  const cuts = findSceneCuts(source, { sensitivity: 50, minimum: 1 });
  assert.ok(cuts.every(cut => cut.time >= 1 && cut.time <= 4));
  assert.ok(cuts.every((cut, i) => !i || cut.time - cuts[i - 1].time >= 1));
});
const fixture = () => {
  const project = newProject();
  const asset: Asset = { id: "scene-source", kind: "video", name: "Scenes.webm", duration: 20, theme: "video", sizeLabel: "1 MB", url: "blob:test" };
  const clip = { ...makeClip(asset, 5, 2), sourceStart: 4, sourceEnd: 16, speed: 2, volume: .8, fadeIn: .3, fadeOut: .4,
    effects: [{ name: "Wavy" as const, amount: 10, waves: 5 }],
    keyframes: [{ time: 0, x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, { time: 6, x: .2, y: .1, scale: 1.5, rotation: 20, opacity: .5 }],
    propertyKeyframes: { volume: [{ time: 0, value: .3 }, { time: 6, value: .9 }] } };
  project.assets = [asset]; project.clips = [clip];
  return { project, clip, key: sceneSourceKey(project, clip) };
};
test("scene splits retain source ranges, speed, audio automation, effects and total duration", () => {
  const { project, clip, key } = fixture();
  const result = applySceneCuts(project, clip.id, key, [4, 2, 2, NaN, -1, 100]);
  const shots = result.clips.toSorted((a, b) => a.start - b.start);
  assert.deepEqual(shots.map(shot => [shot.start, shot.sourceStart, shot.sourceEnd]), [[5, 4, 8], [7, 8, 12], [9, 12, 16]]);
  assert.equal(shots.reduce((sum, shot) => sum + clipDuration(shot), 0), clipDuration(clip));
  assert.equal(endOf(shots.at(-1)!), endOf(clip));
  for (const shot of shots) {
    assert.equal(shot.assetId, clip.assetId); assert.equal(shot.volume, clip.volume); assert.equal(shot.speed, clip.speed); assert.deepEqual(shot.effects, clip.effects);
    for (const offset of [.2, 1]) assert.deepEqual(animatedItem(shot, shot.start + offset).volume, animatedItem(clip, shot.start + offset).volume);
  }
  assert.equal(shots[0].fadeIn, .3); assert.equal(shots[0].fadeOut, 0);
  assert.equal(shots[1].fadeIn, 0); assert.equal(shots[2].fadeOut, .4);
  assert.equal(project.clips.length, 1);
});
test("scene cuts apply and undo/redo in one history batch", () => {
  const { project, clip, key } = fixture();
  const state = { project, past: [], future: [], origin: null, group: "", at: 0 };
  const edited = historyReducer(state, { type: "edit", at: 1, group: "", fn: p => applySceneCuts(p, clip.id, key, [1, 2, 3]) });
  assert.equal(edited.past.length, 1); assert.equal(edited.project.clips.length, 4);
  const undone = historyReducer(edited, { type: "undo" }); assert.equal(undone.project, project);
  assert.equal(historyReducer(undone, { type: "redo" }).project.clips.length, 4);
});
test("scene cuts reject stale, locked, missing and frozen sources", () => {
  const { project, clip, key } = fixture();
  for (const changed of [{ ...project, clips: [{ ...clip, sourceStart: 6 }] }, { ...project, clips: [{ ...clip, scale: 2 }] }, { ...project, lockedTracks: ["layer:2"] }, { ...project, assets: [{ ...project.assets[0], url: "blob:relinked" }] }]) assert.equal(applySceneCuts(changed, clip.id, key, [2]), changed);
  const frozen = { ...project, clips: [{ ...clip, frozenAt: 5 }] };
  assert.equal(applySceneCuts(frozen, clip.id, sceneSourceKey(frozen, frozen.clips[0]), [2]), frozen);
  assert.equal(applySceneCuts(project, "missing", key, [2]), project);
  const detached = { ...project, clips: [{ ...clip, kind: "audio" as const }] };
  assert.equal(applySceneCuts(detached, clip.id, sceneSourceKey(detached, detached.clips[0]), [2]), detached);
});
test("scene marker-only mode preserves clips and manual beats, is deduplicated and readable by AI", () => {
  const { project, clip, key } = fixture();
  project.markers = [{ id: "beat", kind: "beat", time: 7 }];
  const result = applySceneCuts(project, clip.id, key, [2, 4], "markers");
  assert.equal(result.clips, project.clips);
  assert.deepEqual(result.markers.map(marker => [marker.kind, marker.time]), [["beat", 7], ["moment", 7], ["moment", 9]]);
  assert.equal(result.markers[1].sourceClipId, clip.id);
  assert.equal(result.markers[1].source, "scene");
  assert.equal(migrateProject(JSON.parse(JSON.stringify(result)), result.assets).markers[1].source, "scene");
  assert.equal(projectSnapshot(result).markers[1].source, "scene");
  assert.match(editingCatalog().markerSemantics, /detected hard-cut boundaries/);
  assert.equal(applySceneCuts(result, clip.id, key, [2, 4], "markers"), result);
});
