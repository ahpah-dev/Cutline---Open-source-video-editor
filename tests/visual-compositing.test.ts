import test from "node:test";
import assert from "node:assert/strict";
import { animatedItem, insertLayer, makeClip, makeText, migrateProject, newProject, setPropertyKeyframe, type Asset } from "../app/editor/model";
import { applyCodexEdits, projectRevision, projectSnapshot } from "../app/editor/codexEditing";
import { canvasBlendMode, chromaAlpha, DEFAULT_COMPOSITING, keyChromaPixels, maskGeometry, normalizeCompositing } from "../app/editor/visualCompositing";
import { applyMaskPatch, maskDragPatch } from "../app/editor/maskEditing";

const asset: Asset = { id: "image", name: "image.png", kind: "image", duration: 4, width: 100, height: 100, theme: "image", sizeLabel: "1 KB" };
const edit = (project: ReturnType<typeof newProject>, operations: unknown[]) => applyCodexEdits(project, { projectId: project.id, expectedRevision: projectRevision(project), operations }).project;

test("Compositing defaults preserve old projects; invalid imported values normalize safely", () => {
  assert.deepEqual(normalizeCompositing({}), DEFAULT_COMPOSITING);
  const project = newProject(); project.assets = [asset]; project.clips = [makeClip(asset)]; project.texts = [makeText()];
  const restored = migrateProject({ ...project, lockedTracks: ["layer:1", "layer:1", "layer:99999", "bad"], clips: [{ ...project.clips[0], maskWidth: Infinity, maskFeather: 4, chromaColor: "unsafe", audioPan: NaN }] }, [asset]);
  assert.equal(restored.clips[0].maskWidth, 1); assert.equal(restored.clips[0].maskFeather, 0.5);
  assert.equal(restored.clips[0].chromaColor, "#00ff00"); assert.equal(restored.clips[0].audioPan, 0);
  assert.deepEqual(restored.lockedTracks, ["layer:1"]);
  assert.deepEqual(insertLayer(restored, 1).lockedTracks, ["layer:2"]);
});

test("Content masks follow rotation and flips while canvas masks remain fixed", () => {
  const frame = { x: 100, y: 100, width: 200, height: 100, rotation: 90, flipX: true };
  const content = maskGeometry({ maskShape: "Rectangle", maskX: 0.75, maskY: 0.5, maskWidth: 0.5, maskHeight: 0.5, maskRotation: 30, maskFeather: 0.1 }, frame, 320, 180);
  assert.ok(Math.abs(content.x - 100) < 0.001); assert.ok(Math.abs(content.y - 50) < 0.001);
  assert.equal(content.width, 100); assert.equal(content.height, 50); assert.equal(content.rotation, 60); assert.equal(content.feather, 10);
  const canvas = maskGeometry({ maskShape: "Ellipse", maskSpace: "canvas" }, frame, 320, 180);
  assert.equal(canvas.x, 160); assert.equal(canvas.y, 90); assert.equal(canvas.rotation, 0); assert.equal(canvas.flipX, false);
});

test("Mask, key color, blend and stereo pan use existing numeric/color/stepped keyframe semantics", () => {
  let clip = makeClip(asset);
  clip = setPropertyKeyframe(clip, "maskX", 0, 0.2); clip = setPropertyKeyframe(clip, "maskX", 2, 0.8);
  clip = setPropertyKeyframe(clip, "maskInvert", 0, false); clip = setPropertyKeyframe(clip, "maskInvert", 2, true);
  clip = setPropertyKeyframe(clip, "chromaColor", 0, "#00ff00"); clip = setPropertyKeyframe(clip, "chromaColor", 2, "#0000ff");
  clip = setPropertyKeyframe(clip, "audioPan", 0, -1); clip = setPropertyKeyframe(clip, "audioPan", 2, 1);
  const middle = animatedItem(clip, 1);
  assert.equal(middle.maskX, 0.5); assert.equal(middle.maskInvert, false); assert.equal(middle.chromaColor, "#008080"); assert.equal(middle.audioPan, 0);
  assert.equal(animatedItem(clip, 2).maskInvert, true);
});

test("CPU chroma fallback removes the key, keeps foreground alpha and softens edge spill", () => {
  const pixels = new Uint8ClampedArray([0,255,0,255, 255,0,0,128, 255,255,255,255, 0,0,0,255, 0,160,0,255]);
  keyChromaPixels(pixels, { chromaKey: true, chromaTolerance: 0.1, chromaSoftness: 0.25, chromaSpill: 1 });
  assert.equal(pixels[3], 0); assert.equal(pixels[7], 128); assert.equal(pixels[11], 255); assert.equal(pixels[15], 255);
  assert.ok(pixels[19] > 0 && pixels[19] < 255); assert.ok(pixels[17] < 160);
  assert.equal(chromaAlpha(0.2, 0.2, 0), 0); assert.equal(chromaAlpha(0.201, 0.2, 0), 1);
});

test("AI can set and keyframe compositing with normalized units, but locked layers reject atomic edits", () => {
  let project = newProject(); project.assets = [asset]; project.clips = [makeClip(asset)];
  const id = project.clips[0].id;
  project = edit(project, [{ op: "update", id, maskShape: "Heart", maskWidth: 0.7, maskFeather: 0.03, chromaKey: true, blendMode: "Screen" }, { op: "keyframe", id, property: "maskX", at: 0, value: 0.25 }, { op: "keyframe", id, property: "maskX", at: 2, value: 0.75 }, { op: "layer", track: 0, locked: true }]);
  assert.equal(animatedItem(project.clips[0], 1).maskX, 0.5);
  assert.deepEqual(projectSnapshot(project).lockedTracks, ["layer:0"]);
  const before = structuredClone(project);
  assert.throws(() => edit(project, [{ op: "project", patch: { name: "Never committed" } }, { op: "update", id, maskShape: "None" }]), /locked/);
  assert.deepEqual(project, before);
  assert.throws(() => edit(project, [{ op: "add_text", text: "Locked", start: 0, duration: 2, track: 0 }]), /locked/);
  const unlocked = edit(project, [{ op: "layer", track: 0, locked: false }, { op: "update", id, maskShape: "None" }]);
  assert.equal(unlocked.clips[0].maskShape, "None");
  unlocked.lockedTracks = ["layer:2"];
  assert.throws(() => edit(unlocked, [{ op: "update", id, track: 2 }]), /locked/);
  assert.throws(() => edit(unlocked, [{ op: "duplicate", id, start: 4, track: 2 }]), /locked/);
});

test("Canvas blend mapping only produces supported compositing operations", () => {
  assert.equal(canvasBlendMode("Normal"), "source-over"); assert.equal(canvasBlendMode("Color dodge"), "color-dodge");
  assert.equal(canvasBlendMode("Soft light"), "soft-light"); assert.equal(canvasBlendMode("Add"), "lighter");
});

test("Mask drag translates rotated/flipped reference coordinates and preserves keyframes", () => {
  const item = { ...makeClip(asset), maskShape: "Ellipse" as const, maskWidth: 0.5, maskHeight: 0.6 };
  const frame = { x: 100, y: 100, width: 200, height: 100, rotation: 90, flipX: true };
  const geometry = maskGeometry(item, frame, 320, 180);
  const moved = maskDragPatch(item, frame, geometry, "move", 0, 20);
  assert.ok(Math.abs(moved.maskX! - 0.4) < 1e-9);
  assert.ok(Math.abs(moved.maskY! - 0.5) < 1e-9);
  assert.equal(maskDragPatch(item, frame, geometry, "rotate", 0, 0, 45).maskRotation, -45);
  const resized = maskDragPatch(item, frame, geometry, "size", -10, 20);
  assert.ok(Math.abs(resized.maskWidth! - 0.7) < 1e-9);
  assert.ok(Math.abs(resized.maskHeight! - 0.8) < 1e-9);
  const keyed = setPropertyKeyframe(setPropertyKeyframe(item, "maskX", 0, .2), "maskX", 2, .8);
  const edited = applyMaskPatch(keyed, { maskX: .35, maskFeather: .1 }, 1, 30);
  assert.equal(animatedItem(edited, 1).maskX, .35);
  assert.equal(edited.propertyKeyframes!.maskX.length, 3);
  assert.equal(edited.maskFeather, .1);
  assert.equal(keyed.propertyKeyframes!.maskX.length, 2, "Drag must not mutate its undo origin");
});
