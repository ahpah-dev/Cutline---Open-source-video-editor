import test from "node:test";
import assert from "node:assert/strict";
import { applyCodexEdits, projectRevision, projectSnapshot, CODEX_TOOLS } from "../app/editor/codexEditing";
import { newProject, makeClip, makeText, endOf, type Project } from "../app/editor/model";
import { historyReducer } from "../app/editor/useProject";

function edit(project: Project, operations: unknown[]) {
  return applyCodexEdits(project, { projectId: project.id, expectedRevision: projectRevision(project), operations });
}
test("Codex creates, references, styles and keyframes items in one undoable batch", () => {
  const p = newProject();
  const result = edit(p, [
    { op: "add_text", ref: "title", text: "Hello", start: 0, duration: 4, track: 5, patch: { fontSize: 100, fillMode: "linear", gradientStops: [{ color: "#ff0000", position: 0 }, { color: "#00ff00", position: 1 }] } },
    { op: "animation", id: "@title", phase: "Entrance", duration: 1, layers: [{ name: "Letter Pop In" }, { name: "Fade" }] },
    { op: "combo", id: "@title", layers: [{ name: "Pulse", speed: 1, amount: 30 }] },
    { op: "effect", id: "@title", name: "Wavy", amount: 25, waves: 8 },
    { op: "keyframe", id: "@title", property: "x", at: 2, value: 0.75 },
  ]);
  assert.equal(p.texts.length, 0);
  const text = result.project.texts[0];
  assert.equal(text.text, "Hello");
  assert.equal(text.id, result.result.refs.title);
  assert.equal(text.animationStack?.length, 2);
  assert.ok(text.animationStack?.[0].settings);
  assert.equal(text.effects[0].waves, 8);
  assert.equal(text.propertyKeyframes?.x?.[0].time, 2);
  assert.equal(result.project.layerCount, 6);
  const state = { project: p, past: [], future: [], origin: null, group: "", at: 0 };
  const edited = historyReducer(state, { type: "edit", fn: () => result.project, group: "", at: 1 });
  assert.equal(edited.past.length, 1);
  assert.deepEqual(historyReducer(edited, { type: "undo" }).project, p);
  assert.deepEqual(historyReducer(historyReducer(edited, { type: "undo" }), { type: "redo" }).project, result.project);
});
test("Codex refuses stale revisions and different projects", () => {
  const p = newProject();
  const input = { projectId: p.id, expectedRevision: projectRevision(p), operations: [{ op: "project", patch: { name: "Test" } }] };
  assert.throws(() => applyCodexEdits({ ...p, name: "Manual edit" }, input), /project changed/i);
  assert.throws(() => applyCodexEdits({ ...p, id: "another" }, input), /project changed/i);
});
test("Invalid operations roll back the entire batch without touching source state", () => {
  const p = newProject(), original = JSON.stringify(p);
  assert.throws(() => edit(p, [{ op: "add_text", text: "Never inserted", start: 0, duration: 4, track: 0 }, { op: "update", id: "not-an-item", patch: { opacity: 0.5 } }]), /Operation 2/);
  assert.equal(JSON.stringify(p), original);
  assert.throws(() => edit(p, [{ op: "project", patch: { secret: "bad" } }]), /not editable/);
  assert.throws(() => edit(p, [{ op: "add_text", text: "NaN", start: NaN, duration: 4, track: 0 }]), /numeric range/);
  assert.throws(() => edit(p, [{ op: "add_clip", assetId: "missing", start: 0, track: 0 }]), /Import this media first/);
});
test("Codex splits and trims source media and edits a genuine two-sided transition", () => {
  const p = newProject();
  p.assets = [{ id: "video", name: "local.mp4", kind: "video", duration: 10, theme: "video", sizeLabel: "1 MB", url: "blob:private", thumbnail: "data:private" }];
  const result = edit(p, [
    { op: "add_clip", assetId: "video", start: 0, track: 0, ref: "source", sourceEnd: 8 },
    { op: "split", id: "@source", at: 4, ref: "right" },
    { op: "transition", id: "@right", name: "Dissolve", duration: 1.2 },
    { op: "transition", id: "@right", name: "Dissolve", duration: 1.2 },
    { op: "duplicate", id: "@right", start: 8, track: 1, ref: "copy" },
  ]);
  assert.equal(result.project.clips.length, 3);
  assert.equal(endOf(result.project.clips[0]), 4);
  assert.equal(result.project.clips[1].sourceStart, 4);
  assert.equal(result.project.clips[1].transitionDuration, 1.2);
  assert.throws(() => edit(result.project, [{ op: "trim_clip", id: result.result.refs.copy, sourceStart: 0, sourceEnd: 12 }]), /beyond its source/);
  assert.throws(() => edit(result.project, [{ op: "trim_clip", id: result.result.refs.copy, sourceStart: 0, sourceEnd: 0.001 }]), /one frame/);
  assert.throws(() => edit(result.project, [{ op: "transition", id: result.result.refs.copy, name: "Dissolve", duration: 1 }]), /preceding visual clip/);
  const snapshot = JSON.stringify(projectSnapshot(result.project));
  assert.ok(!snapshot.includes("blob:private") && !snapshot.includes("data:private"));
});
test("Codex enforces item-specific properties and normalizes frame timing", () => {
  const p = newProject();
  p.texts = [makeText()];
  assert.throws(() => edit(p, [{ op: "update", id: p.texts[0].id, patch: { volume: 1 } }]), /not editable/);
  const result = edit(p, [{ op: "update", id: p.texts[0].id, patch: { start: 0.021, duration: 0.04 } }]);
  assert.equal(result.project.texts[0].start, 1 / p.fps);
  p.assets = [{ id: "v", kind: "video", duration: 10, name: "V", theme: "video", sizeLabel: "1 MB" }];
  p.clips = [makeClip(p.assets[0])];
  assert.throws(() => edit(p, [{ op: "animation", id: p.clips[0].id, phase: "Entrance", duration: 1, layers: [{ name: "Letter Pop In" }] }]), /text animation/);
  assert.throws(() => edit(p, [{ op: "keyframe", id: p.texts[0].id, property: "text", value: "bad", at: 0 }]), /cannot be keyframed/);
  assert.equal(CODEX_TOOLS.length, 6);
});
test("Codex accepts simple flat styling while preserving strict validation", () => {
  const p = newProject();
  const result = edit(p, [{ op: "add_text", ref: "t", text: "Simple", start: 0, duration: 2, track: 1, x: 0.5, y: 0.5, fontSize: 96, color: "#ffffff", patch: { fontSize: 72 } }, { op: "update", id: "@t", opacity: 0.8 }]);
  assert.equal(result.project.texts[0].fontSize, 96);
  assert.equal(result.project.texts[0].opacity, 0.8);
  assert.throws(() => edit(result.project, [{ op: "update", id: result.result.refs.t, volume: 1 }]), /not editable/);
  assert.throws(() => edit(result.project, [{ op: "update", id: result.result.refs.t }]), /at least one property/);
});
test("Codex freezes video, changes layer flags and keyframes normalized gradient stops", () => {
  const p = newProject();
  p.assets = [{ id: "v", kind: "video", duration: 10, name: "V", theme: "video", sizeLabel: "1 MB" }];
  p.clips = [makeClip(p.assets[0])];
  const frozen = edit(p, [{ op: "freeze", id: p.clips[0].id, at: 2, duration: 3, ref: "hold" }, { op: "layer", track: 0, muted: true, hidden: true }]);
  const hold = frozen.project.clips.find((clip) => clip.id === frozen.result.refs.hold)!;
  assert.equal(hold.frozenAt, 2);
  assert.equal(endOf(hold) - hold.start, 3);
  assert.deepEqual(frozen.project.mutedTracks, ["layer:0"]);
  assert.deepEqual(frozen.project.hiddenTracks, ["layer:0"]);
  const title = edit(p, [{ op: "add_text", ref: "t", text: "Gradient", start: 1, duration: 3, track: 1, patch: { start: 99, gradientStops: [{ color: "#ff0000", position: 0 }, { color: "#00ff00", position: 1 }] } }]);
  assert.equal(title.project.texts[0].start, 1);
  const stop = title.project.texts[0].gradientStops[0];
  assert.ok(stop.id);
  const keyed = edit(title.project, [{ op: "keyframe", id: title.result.refs.t, property: `gradientStop:${stop.id}:color`, at: 2, value: "#0000ff" }]);
  assert.equal(keyed.project.texts[0].propertyKeyframes?.[`gradientStop:${stop.id}:color`][0].time, 1);
});
