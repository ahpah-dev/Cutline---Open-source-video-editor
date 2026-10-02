import assert from "node:assert/strict";
import test from "node:test";
import {
  clipDuration,
  animatedItem,
  endOf,
  freezeFrame,
  interpolatedTransform,
  makeClip,
  makeText,
  makeComboAnimation,
  normalizeComboAnimations,
  COMBO_ANIMATIONS,
  normalizeGradientStops,
  migrateProject,
  newProject,
  parseSrt,
  projectDuration,
  snapPosition,
  setJoinTransition,
  splitItem,
  transitionSource,
  transitionWindow,
  trimItem,
  dimensions,
  trackKey,
  insertLayer,
  moveToLayer,
  setPropertyKeyframe,
  togglePropertyKeyframe,
  type Asset,
  type Project,
} from "../app/editor/model";
import { historyReducer } from "../app/editor/useProject";
import { applyPreviewTransform, snapCanvasCenter } from "../app/editor/previewAlignment";
import { cropToAspect, dragCrop, FULL_CROP, normalizeCrop } from "../app/editor/crop";
import { ANIMATIONS, TEXT_PRESETS } from "../app/editor/presets";
import { comboMotion, letterPopProgress, textAnimationTiming, textMotion } from "../app/editor/textAnimation";
import { createCustomAnimationPreset, parseCustomAnimationPresets } from "../app/editor/customAnimationPresets";
import { sampleProject } from "./fixtures";
import { wordsToCaptions } from "../app/editor/whisper";

const video: Asset = {
  id: "v",
  name: "Source.mp4",
  kind: "video",
  duration: 20,
  sizeLabel: "1 MB",
  theme: "video",
};
test("new projects start with an empty media library and timeline", () => {
  const p = newProject();
  assert.equal(p.name, "Untitled project");
  assert.deepEqual(p.assets, []);
  assert.deepEqual(p.clips, []);
  assert.deepEqual(p.texts, []);
});
test("new still images fit inside the canvas while videos continue to fill it", () => {
  assert.equal(makeClip({ ...video, kind: "image", name: "Portrait.webp" }).fit, "contain");
  assert.equal(makeClip(video).fit, "cover");
});
test("text gradients keep editable stops in backups and migrate older solid text safely", () => {
  const text = makeText(0, {
    fillMode: "radial", gradientCenterX: 0.3, gradientCenterY: 0.8,
    gradientRadius: 1.4,
    gradientStops: [
      { id: "a", position: 0, color: "#fff2bb" },
      { id: "b", position: 0.35, color: "#e85d9c" },
      { id: "c", position: 1, color: "#5a62db" },
    ],
  });
  const project = newProject(); project.texts = [text];
  const restored = migrateProject(JSON.parse(JSON.stringify(project)), []);
  assert.deepEqual(restored.texts[0].gradientStops, text.gradientStops);
  assert.equal(restored.texts[0].fillMode, "radial");
  assert.equal(restored.texts[0].gradientRadius, 1.4);
  const legacy = migrateProject({ ...project, texts: [{ ...text, fillMode: undefined, gradientStops: undefined }] }, []);
  assert.equal(legacy.texts[0].fillMode, "solid");
  assert.equal(legacy.texts[0].gradientStops.length, 2);
  assert.deepEqual(normalizeGradientStops([{ color: "bad", position: 2 }]), legacy.texts[0].gradientStops);
});
test("text gradient angle and individual stop properties can be keyframed", () => {
  let text = makeText(0, { fillMode: "linear", duration: 4 });
  text = setPropertyKeyframe(text, "gradientAngle", 0, 0);
  text = setPropertyKeyframe(text, "gradientAngle", 2, 180);
  text = setPropertyKeyframe(text, "gradientStop:start:color", 0, "#ff0000");
  text = setPropertyKeyframe(text, "gradientStop:start:color", 2, "#0000ff");
  text = setPropertyKeyframe(text, "gradientStop:end:position", 0, 0.5);
  text = setPropertyKeyframe(text, "gradientStop:end:position", 2, 1);
  const middle = animatedItem(text, 1);
  assert.equal(middle.gradientAngle, 90);
  assert.equal(middle.gradientStops[0].color, "#800080");
  assert.equal(middle.gradientStops[1].position, 0.75);
  assert.equal(text.gradientStops[0].color, "#ffffff", "Keyframes must not mutate the authored fill");
});
test("old image imports adopt fit-inside once without undoing a chosen crop", () => {
  const image: Asset = { ...video, kind: "image", name: "Portrait.webp" };
  const project = newProject(); project.assets = [image];
  project.clips = [{ ...makeClip(image), fit: "cover" }];
  const migrated = migrateProject(project, [image]);
  assert.equal(migrated.clips[0].fit, "contain");
  const chosen = migrateProject({ ...project, clips: [{ ...project.clips[0], fitExplicit: true }] }, [image]);
  assert.equal(chosen.clips[0].fit, "cover");
});
test("loading old projects and backups removes only samples, preserving imports and edits", () => {
  const p = sampleProject();
  p.assets.push(video);
  const imported = { ...makeClip(video, 12, 3), sourceStart: 2, sourceEnd: 8 };
  p.clips.push(imported);
  p.texts.push(makeText(13, { text: "My title", exitAnimation: "Spin" }));
  p.hiddenTracks = ["layer:3"];
  for (const assets of [p.assets, [video]]) {
    const restored = migrateProject(JSON.parse(JSON.stringify(p)), assets);
    assert.deepEqual(restored.assets, [video]);
    assert.deepEqual(restored.clips, [imported]);
    assert.deepEqual(restored.texts, p.texts);
    assert.deepEqual(restored.hiddenTracks, p.hiddenTracks);
    assert.equal(restored.id, p.id);
    assert.equal(restored.name, p.name);
    assert.deepEqual(migrateProject(restored, restored.assets), restored);
  }
});
test("removing samples preserves gaps in legacy sequential projects", () => {
  const restored = migrateProject({
    version: 1,
    clips: [
      { assetId: "demo-aurora", sourceStart: 0, sourceEnd: 4.8 },
      { assetId: "v", sourceStart: 0, sourceEnd: 3 },
      { assetId: "demo-alpine", sourceStart: 0, sourceEnd: 4.2, speed: 2 },
      { assetId: "v", sourceStart: 2, sourceEnd: 5 },
    ],
  }, [video]);
  assert.equal(restored.clips.length, 2);
  assert.equal(restored.clips[0].start, 4.8);
  assert.equal(restored.clips[1].start, 9.9);
});
test("all text styles insert New Text and retain their distinct styling", () => {
  assert.equal(makeText().text, "New Text");
  assert.ok(TEXT_PRESETS.length >= 12);
  for (const preset of TEXT_PRESETS) assert.equal(preset.sample, "New Text");
  assert.ok(
    new Set(TEXT_PRESETS.map((p) => JSON.stringify(p.style))).size >= 12,
  );
});
test("media and text alignment snapping default on and preserve an opt-out across migration", () => {
  assert.equal(makeClip(video).snapToGuides, true);
  const media = makeClip(video); delete media.snapToGuides;
  assert.equal(migrateProject({ ...newProject(), assets: [video], clips: [media] }, [video]).clips[0].snapToGuides, true);
  assert.equal(migrateProject({ ...newProject(), assets: [video], clips: [{ ...media, snapToGuides: false }] }, [video]).clips[0].snapToGuides, false);
  assert.equal(makeText().snapToGuides, true);
  const legacy = makeText();
  delete legacy.snapToGuides;
  const enabled = migrateProject(
    { ...newProject(), texts: [legacy] },
    [video],
  );
  assert.equal(enabled.texts[0].snapToGuides, true);
  const disabled = migrateProject(
    { ...newProject(), texts: [makeText(0, { snapToGuides: false })] },
    [video],
  );
  assert.equal(disabled.texts[0].snapToGuides, false);
});
test("source crops normalize safely, migrate, split and undo without changing originals", () => {
  assert.deepEqual(normalizeCrop(undefined), FULL_CROP);
  assert.deepEqual(normalizeCrop({ x: NaN, y: Infinity, width: -2, height: 4 }), { x: 0, y: 0, width: 0.01, height: 1 });
  const crop = normalizeCrop({ x: 0.9, y: 0.8, width: 0.9, height: 0.7 });
  assert.ok(crop.x + crop.width <= 1 && crop.y + crop.height <= 1);
  const clip = { ...makeClip(video), crop: { x: 0.25, y: 0, width: 0.5, height: 1 } };
  const project = { ...newProject(), assets: [video], clips: [clip] };
  assert.deepEqual(migrateProject(project, [video]).clips[0].crop, clip.crop);
  const split = splitItem(project, { kind: "clip", id: clip.id }, 1);
  assert.deepEqual(split.project.clips[1].crop, clip.crop);
  const initial = { project, past: [], future: [], origin: null, group: "", at: 0 };
  const edited = historyReducer(initial, { type: "edit", group: "crop", at: 1, fn: (p) => ({ ...p, clips: [{ ...clip, crop: { ...FULL_CROP } }] }) });
  assert.deepEqual(historyReducer(edited, { type: "undo" }).project.clips[0].crop, clip.crop);
  assert.deepEqual(makeClip(video).crop, FULL_CROP);
});
test("crop presets and corner/move drags stay inside source and preserve locked ratios", () => {
  const square = cropToAspect(FULL_CROP, 1, 2);
  assert.deepEqual(square, { x: 0.25, y: 0, width: 0.5, height: 1 });
  const moved = dragCrop(square, "move", 2, 2);
  assert.equal(moved.x, 0.5); assert.equal(moved.y, 0);
  for (const mode of ["nw", "ne", "sw", "se"] as const) {
    for (const delta of [-3, -0.2, 0.2, 3]) {
      const resized = dragCrop({ x: 0.2, y: 0.2, width: 0.4, height: 0.4 }, mode, delta, -delta, 0.5);
      assert.ok(resized.x >= -1e-9 && resized.y >= -1e-9 && resized.x + resized.width <= 1.00000001 && resized.y + resized.height <= 1.00000001);
      assert.ok(Math.abs(resized.width / resized.height - 0.5) < 1e-9);
    }
  }
});
test("preview center snapping uses visible centers, independent axes and CSS pixels", () => {
  assert.deepEqual(snapCanvasCenter(0.01, 0.02, 0, 0, 0, 1000, 500, true), { x: 0, y: 0, snapX: true, snapY: true });
  assert.deepEqual(snapCanvasCenter(0.02, 0.01, 0, 0, 0, 1000, 500, true), { x: 0.02, y: 0, snapX: false, snapY: true });
  assert.equal(snapCanvasCenter(0.02, 0, 0, 0, 0, 500, 500, true).x, 0);
  assert.equal(snapCanvasCenter(0.01, 0.02, 0, 0, 0, 1000, 500, false).x, 0.01);
  // Left-aligned / rotated text is centered by its rendered bounds, not its anchor.
  const text = snapCanvasCenter(0.405, 0.46, 0.1, 0.05, 0.5, 1000, 500, true);
  assert.equal(text.x, 0.4); assert.equal(text.y, 0.45);
});
test("preview dragging updates active property and legacy motion keyframes", () => {
  let clip = makeClip(video);
  clip = setPropertyKeyframe(clip, "x", 0, 0.2, 30);
  clip = setPropertyKeyframe(clip, "x", 2, 0.4, 30);
  const changed = applyPreviewTransform(clip, { x: 0, y: 0 }, 1, 30);
  assert.equal(interpolatedTransform(changed, 1).x, 0);
  assert.equal(changed.propertyKeyframes!.x.length, 3);
  assert.equal(clip.propertyKeyframes!.x.length, 2);
  const legacy = { ...makeClip(video), keyframes: [{ time: 0, x: 0.2, y: 0.3, scale: 1, rotation: 20, opacity: 1 }] };
  assert.equal(interpolatedTransform(applyPreviewTransform(legacy, { x: 0 }, 1, 30), 1).x, 0);
  let text = setPropertyKeyframe(makeText(), "x", 0, 0.2, 30);
  text = applyPreviewTransform(text, { x: 0.5 }, 0, 30);
  assert.equal(animatedItem(text, 0).x, 0.5);
});
test("Combo animations loop through clips and stay editable across project backups", () => {
  const text = makeText(0, {
    duration: 8,
    comboAnimations: COMBO_ANIMATIONS.map(makeComboAnimation),
  });
  const middle = textMotion(text, 3.7);
  assert.ok(
    [middle.x, middle.y, middle.scaleX - 1, middle.scaleY - 1, middle.rotation]
      .some((value) => Math.abs(value) > 0.001),
    "Combo stack should remain active in the middle of the clip",
  );
  assert.equal(textMotion(text, 0.2).opacity, 1);
  assert.equal(textMotion(text, 7.9).opacity, 1);
  const videoClip = makeClip(video, 0);
  videoClip.comboAnimations = [makeComboAnimation("Wave")];
  const videoMotion = comboMotion(videoClip, 0.37);
  assert.ok(Math.abs(videoMotion.x) + Math.abs(videoMotion.y) + Math.abs(videoMotion.rotation) > 0.001);
  const restored = migrateProject(
    JSON.parse(JSON.stringify({ ...newProject(), texts: [text], clips: [videoClip] })),
    [video],
  );
  assert.deepEqual(restored.texts[0].comboAnimations, text.comboAnimations);
  assert.deepEqual(restored.clips[0].comboAnimations, videoClip.comboAnimations);
  assert.deepEqual(normalizeComboAnimations([
    { name: "Pulse", speed: 99, amount: -4 },
    { name: "Pulse", speed: 1, amount: 20 },
    { name: "Not a loop", speed: 1, amount: 50 },
  ]), [{ name: "Pulse", speed: 4, amount: 0 }]);
});
test("Letter Pop In staggers each character and completes the whole phrase", () => {
  const progress = [0, 1, 2, 3].map((index) => letterPopProgress(0.35, index, 4));
  assert.ok(progress[0] > progress[1] && progress[1] > progress[2]);
  assert.equal(progress[3], 0);
  assert.deepEqual([0, 1, 2, 3].map((index) => letterPopProgress(1, index, 4)), [1, 1, 1, 1]);
});

test("entrance and exit presets have independent bounded timelines", () => {
  for (const name of ANIMATIONS.filter((n) => n !== "None")) {
    const t = makeText(2, {
      animation: name,
      animationDuration: 1,
      exitAnimation: name,
      exitAnimationDuration: 1,
    });
    for (const time of [2, 2.2, 2.8, 3, 4, 5.2, 5.8, 6]) {
      const pose = textMotion(t, time);
      assert.ok(
        Object.values(pose)
          .filter((v) => typeof v === "number")
          .every(Number.isFinite),
        name,
      );
      assert.ok(pose.opacity >= 0 && pose.opacity <= 1, name);
    }
    const idle = textMotion(t, 4);
    assert.equal(idle.x, 0, name);
    assert.equal(idle.y, 0, name);
    assert.equal(idle.scaleX, 1, name);
    assert.equal(idle.opacity, 1, name);
    assert.equal(textMotion(t, 6).opacity, 0, name);
  }
  const short = makeText(0, {
    duration: 0.4,
    animation: "Spin",
    animationDuration: 1,
    exitAnimation: "Blur",
    exitAnimationDuration: 3,
  });
  const timing = textAnimationTiming(short);
  assert.equal(timing.entranceDuration, 0.1);
  assert.ok(Math.abs(timing.exitDuration - 0.3) < 1e-9);
  const instant = makeText(0, {
    animation: "Flip",
    animationDuration: 0,
    exitAnimation: "Spin",
    exitAnimationDuration: 0,
  });
  assert.equal(textMotion(instant, 0.1).opacity, 1);
});
test("Zoom exits can grow or shrink while disappearing, and Drift follows a chosen angle", () => {
  const base = makeText(0, { duration: 4, exitAnimation: "Zoom", exitAnimationDuration: 1 });
  const grow = textMotion({ ...base, exitAnimationSettings: { zoomDirection: "in", zoomAmount: 0.8 } }, 3.8);
  const shrink = textMotion({ ...base, exitAnimationSettings: { zoomDirection: "out", zoomAmount: 0.8 } }, 3.8);
  assert.ok(grow.scaleX > 1);
  assert.ok(shrink.scaleX < 1);
  assert.ok(grow.opacity < 1 && shrink.opacity < 1);
  const drift = { ...base, exitAnimation: "Drift" as const };
  const right = textMotion({ ...drift, exitAnimationSettings: { angle: 0, distance: 0.2 } }, 3.8);
  const left = textMotion({ ...drift, exitAnimationSettings: { angle: 180, distance: 0.2 } }, 3.8);
  assert.ok(right.x > 0 && left.x < 0);
  assert.ok(Math.abs(right.y) < 0.000001);
});
test("entrance and exit stacks combine motion and remain independent through backups and splits", () => {
  const text = makeText(0, {
    duration: 4,
    animation: "Drift", animationDuration: 1,
    animationStack: [
      { name: "Drift", settings: { angle: 0, distance: 0.2, fade: false } },
      { name: "Zoom", settings: { zoomDirection: "in", zoomAmount: 0.6, fade: false } },
      { name: "Spin", settings: { rotation: 45, fade: false } },
    ],
    exitAnimation: "Zoom", exitAnimationDuration: 1,
    exitAnimationStack: [
      { name: "Zoom", settings: { zoomDirection: "out", zoomAmount: 0.7 } },
      { name: "Drift", settings: { angle: 270, distance: 0.15, fade: false } },
    ],
  });
  const entering = textMotion(text, 0.2);
  assert.ok(entering.x > 0 && entering.scaleX < 1 && entering.rotation > 0);
  assert.equal(entering.opacity, 1);
  const leaving = textMotion(text, 3.8);
  assert.ok(leaving.y < 0 && leaving.scaleX < 1 && leaving.opacity < 1);
  assert.equal(textMotion(text, 2).scaleX, 1);
  const p = newProject(); p.texts = [text];
  assert.deepEqual(migrateProject(JSON.parse(JSON.stringify(p)), []).texts[0].exitAnimationStack, text.exitAnimationStack);
  const split = splitItem(p, { kind: "text", id: text.id }, 2).project;
  assert.deepEqual(split.texts[0].exitAnimationStack, []);
  assert.deepEqual(split.texts[1].animationStack, []);
  assert.equal(split.texts[1].exitAnimationStack?.length, 2);
});
test("saved custom animation recipes validate, persist in clips, and work on video", () => {
  const preset = createCustomAnimationPreset("Orbit away", "Exit", "Custom", 0.7,
    { angle: 315, distance: 0.18, zoomDirection: "in", zoomAmount: 0.5, rotation: 45, blur: 0.01, fade: true });
  const [loaded] = parseCustomAnimationPresets(JSON.stringify([preset]));
  assert.deepEqual(loaded, preset);
  assert.deepEqual(parseCustomAnimationPresets("bad json"), []);
  const clip = { ...makeClip(video, 1), sourceEnd: 4, exitAnimation: loaded.base,
    exitAnimationDuration: loaded.duration, exitAnimationSettings: loaded.settings, exitAnimationPresetName: loaded.name };
  const motion = textMotion(clip, 4.9, false);
  assert.ok(motion.x > 0 && motion.y < 0 && motion.scaleX > 1 && motion.rotation > 0 && motion.blur > 0 && motion.opacity < 1);
  const p = newProject(); p.assets = [video]; p.clips = [clip];
  const restored = migrateProject(JSON.parse(JSON.stringify(p)), [video]);
  assert.deepEqual(restored.clips[0].exitAnimationSettings, loaded.settings);
  const split = splitItem(p, { kind: "clip", id: clip.id }, 2.5).project;
  assert.equal(split.clips[0].exitAnimation, "None");
  assert.equal(split.clips[1].animation, "None");
  assert.equal(split.clips[1].exitAnimationPresetName, "Orbit away");
  const stacked = createCustomAnimationPreset("Slide + fade", "Entrance", "Slide", 0.8, {}, [
    { name: "Slide", settings: { angle: 180, distance: 0.2, fade: false } },
    { name: "Fade", settings: { easing: "ease-in" } },
  ]);
  assert.deepEqual(parseCustomAnimationPresets(JSON.stringify([stacked]))[0].layers, stacked.layers);
});
test("text effects and exit presets survive migration, split and undo", () => {
  const p = newProject();
  p.texts = [
    makeText(0, {
      animation: "Bounce",
      exitAnimation: "Spin",
      exitAnimationDuration: 0.8,
      effects: [{ name: "Glow", amount: 80 }],
    }),
  ];
  const migrated = migrateProject(JSON.parse(JSON.stringify(p)), []);
  assert.deepEqual(migrated.texts, p.texts);
  const split = splitItem(p, { kind: "text", id: p.texts[0].id }, 2).project;
  assert.equal(split.texts[0].exitAnimation, "None");
  assert.equal(split.texts[1].animation, "None");
  assert.equal(split.texts[1].exitAnimation, "Spin");
  assert.deepEqual(split.texts[1].effects, p.texts[0].effects);
  const legacy = JSON.parse(JSON.stringify(p));
  delete legacy.texts[0].exitAnimation;
  delete legacy.texts[0].exitAnimationDuration;
  delete legacy.texts[0].effects;
  legacy.texts[0].fadeOut = 0.7;
  const restored = migrateProject(legacy, []);
  assert.equal(restored.texts[0].exitAnimation, "Fade");
  assert.equal(restored.texts[0].exitAnimationDuration, 0.7);
  assert.deepEqual(restored.texts[0].effects, []);
  let state = {
    project: p,
    past: [] as Project[],
    future: [] as Project[],
    origin: null as Project | null,
    group: "",
    at: 0,
  };
  state = historyReducer(state, {
    type: "edit",
    fn: () => split,
    group: "",
    at: 1,
  });
  state = historyReducer(state, { type: "undo" });
  assert.deepEqual(state.project.texts, p.texts);
});
test("speed-aware split preserves source coverage and total timeline duration", () => {
  const p = newProject();
  const clip = {
    ...makeClip(video, 3),
    sourceStart: 2,
    sourceEnd: 18,
    speed: 2,
  };
  p.assets.push(video);
  p.clips = [clip];
  const result = splitItem(p, { kind: "clip", id: clip.id }, 7);
  assert.equal(result.project.clips.length, 2);
  const [left, right] = result.project.clips;
  assert.equal(left.sourceEnd, 10);
  assert.equal(right.sourceStart, 10);
  assert.equal(right.start, 7);
  assert.equal(endOf(right), endOf(clip));
  assert.equal(clipDuration(left) + clipDuration(right), clipDuration(clip));
});
test("splits at either endpoint are no-ops", () => {
  const p = sampleProject(),
    c = p.clips[0];
  assert.equal(splitItem(p, { kind: "clip", id: c.id }, c.start).project, p);
  assert.equal(splitItem(p, { kind: "clip", id: c.id }, endOf(c)).project, p);
});
test("transitions attach only to actual visual joins on the same layer", () => {
  const p = newProject();
  p.assets = [video];
  const outgoing = { ...makeClip(video, 0, 1), sourceEnd: 3 };
  const incoming = { ...makeClip(video, 3, 1), sourceEnd: 5 };
  p.clips = [outgoing, incoming];
  assert.equal(transitionSource(p, incoming)?.id, outgoing.id);
  const applied = setJoinTransition(p, incoming.id, "Dissolve");
  assert.equal(applied.clips[1].transition, "Dissolve");
  assert.equal(applied.clips[0].transition, "None");
  const window = transitionWindow(applied, applied.clips[1])!;
  assert.equal(window.previous.id, outgoing.id);
  assert.equal(window.start, incoming.start - window.duration / 2);
  assert.equal(window.end, incoming.start + window.duration / 2);
  assert.equal(setJoinTransition(applied, incoming.id, "Dissolve"), applied);
  const separated = { ...p, clips: [outgoing, { ...incoming, start: 3.5 }] };
  assert.equal(transitionSource(separated, separated.clips[1]), undefined);
  assert.equal(setJoinTransition(separated, incoming.id, "Wipe left"), separated);
  const differentLayer = { ...p, clips: [outgoing, { ...incoming, track: 2 }] };
  assert.equal(transitionSource(differentLayer, differentLayer.clips[1]), undefined);
  const overlap = { ...p, clips: [outgoing, { ...incoming, start: 2.5 }] };
  assert.equal(transitionSource(overlap, overlap.clips[1])?.id, outgoing.id);
  assert.equal(setJoinTransition(overlap, incoming.id, "Wipe left").clips[1].transition, "Wipe left");
});
test("freeze inserts a held video frame, shifts later items, and survives a project round trip", () => {
  const p = newProject();
  p.assets = [video];
  const first = makeClip(video, 1, 2);
  first.sourceStart = 4;
  first.sourceEnd = 10;
  first.speed = 2;
  const later = makeClip(video, 4, 2);
  p.clips = [first, later];
  p.texts = [makeText(5, { track: 2 })];
  const result = freezeFrame(p, { kind: "clip", id: first.id }, 2, 2);
  assert.equal(result.project.clips.length, 4);
  const frozen = result.project.clips.find((c) => c.id === result.selection?.id)!;
  assert.equal(frozen.frozenAt, 6);
  assert.equal(frozen.start, 2);
  assert.equal(clipDuration(frozen), 2);
  assert.equal(frozen.volume, 0);
  assert.equal(result.project.clips.find((c) => c.id === later.id)?.start, 6);
  assert.equal(result.project.texts[0].start, 7);
  const right = result.project.clips.find((c) => c.id !== first.id && c.id !== later.id && c.id !== frozen.id)!;
  assert.equal(right.start, 4);
  assert.equal(right.sourceStart, 6);
  assert.equal(trimItem(frozen, "right", 1, video).sourceEnd, 9);
  assert.equal(migrateProject(JSON.parse(JSON.stringify(result.project)), [video]).clips.find((c) => c.id === frozen.id)?.frozenAt, 6);
  assert.equal(freezeFrame(p, { kind: "clip", id: first.id }, 1).project, p);
});
test("trim start cannot reveal source before zero or create a negative duration", () => {
  const c = { ...makeClip(video, 5), sourceStart: 4, sourceEnd: 14, speed: 2 };
  const extended = trimItem(c, "left", -8, video);
  assert.equal(extended.start, 3);
  assert.equal(extended.sourceStart, 0);
  assert.equal(endOf(extended), endOf(c));
  const tiny = trimItem(c, "left", 500, video);
  assert.ok(clipDuration(tiny) >= 1 / 30 - 1e-8);
  assert.equal(endOf(tiny), endOf(c));
});
test("trim end obeys media source duration at different speeds", () => {
  const c = { ...makeClip(video, 0), sourceStart: 2, sourceEnd: 8, speed: 0.5 };
  assert.equal(trimItem(c, "right", 100, video).sourceEnd, 20);
  assert.equal(trimItem(c, "right", 2, video).sourceEnd, 9);
});
test("image and text durations can extend beyond the original default", () => {
  const a = { ...video, kind: "image" as const, duration: 5 };
  assert.equal(clipDuration(trimItem(makeClip(a), "right", 8, a)), 13);
  assert.equal(trimItem(makeText(4), "left", -9).start, 0);
});
test("snapping considers both edges and Alt bypass is frame-aligned", () => {
  assert.equal(snapPosition(4.94, 3, [5, 10], 0.1).position, 5);
  assert.equal(snapPosition(6.97, 3, [10], 0.1).position, 7);
  assert.equal(snapPosition(4.94, 3, [5, 10], 0.1, false).guide, null);
  assert.equal(snapPosition(-2, 3, [0], 0.1).position, 0);
});
test("project duration includes gaps, overlays, text tails, and audio tails", () => {
  const p = newProject();
  p.clips = [
    makeClip(video),
    { ...makeClip(video, 30), kind: "audio", sourceEnd: 2 },
  ];
  p.texts = [makeText(33, { duration: 7 })];
  assert.equal(projectDuration(p), 40);
  p.texts = [];
  assert.equal(projectDuration(p), 32);
});
test("text split preserves content, styling and both time ranges", () => {
  const p = newProject(),
    t = makeText(2, {
      duration: 8,
      text: "Styled",
      strokeWidth: 4,
      animation: "Pop",
    });
  p.texts = [t];
  const result = splitItem(p, { kind: "text", id: t.id }, 5);
  assert.equal(result.project.texts.length, 2);
  assert.equal(result.project.texts[0].duration, 3);
  assert.equal(result.project.texts[1].duration, 5);
  assert.equal(result.project.texts[1].strokeWidth, 4);
  assert.equal(result.project.texts[1].animation, "None");
});
test("keyframes interpolate and splitting does not jump at the cut", () => {
  const p = newProject(),
    c = makeClip(video);
  c.keyframes = [
    { time: 0, x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    { time: 10, x: 0.2, y: 0.4, scale: 2, rotation: 60, opacity: 0.5 },
  ];
  p.clips = [c];
  assert.equal(interpolatedTransform(c, 5).x, 0.1);
  const result = splitItem(p, { kind: "clip", id: c.id }, 5);
  assert.deepEqual(
    interpolatedTransform(result.project.clips[1], 0),
    interpolatedTransform(c, 5),
  );
  assert.deepEqual(
    interpolatedTransform(result.project.clips[0], 5),
    interpolatedTransform(c, 5),
  );
});
test("SRT supports multiline text, millisecond variants and ignores malformed cues", () => {
  const texts = parseSrt(
    "1\r\n00:00:01,5 --> 00:00:03,250\r\nHello\r\nworld\r\n\r\n2\r\n00:00:04.100 --> 00:00:05.000\r\n<b>Next</b>\r\n\r\ninvalid",
  );
  assert.equal(texts.length, 2);
  assert.equal(texts[0].start, 1.5);
  assert.equal(texts[0].duration, 1.75);
  assert.equal(texts[0].text, "Hello\nworld");
  assert.equal(texts[1].text, "Next");
});
test("legacy projects migrate sequential clips, audio and old text sizes", () => {
  const p = migrateProject(
    {
      version: 1,
      projectName: "Keep this",
      clips: [
        {
          id: "one",
          assetId: "v",
          sourceStart: 0,
          sourceEnd: 3,
          x: 20,
          y: -10,
        },
        {
          id: "two",
          assetId: "v",
          sourceStart: 1,
          sourceEnd: 5,
          transition: "Wipe",
        },
      ],
      texts: [{ id: "txt", text: "Hello", start: 1, end: 4, fontSize: 30 }],
    },
    [video],
  );
  assert.equal(p.name, "Keep this");
  assert.equal(p.clips[0].x, 0.2);
  assert.equal(p.clips[0].y, -0.1);
  assert.equal(p.clips[1].start, 3);
  assert.equal(p.clips[1].transition, "Wipe left");
  assert.equal(p.texts[0].duration, 3);
  assert.equal(p.texts[0].fontSize, 60);
});
test("typed-track migration preserves stacking, flags and v3 round trips", () => {
  const old = {
    ...newProject(),
    version: 2,
    clips: [makeClip(video, 0, 4), makeClip(video, 2, 0)],
    texts: [
      makeText(0, { track: 0, x: 0.3, fontSize: 90 }),
      makeText(1, { track: 2 }),
    ],
    hiddenTracks: ["text:0"],
    mutedTracks: ["video:4"],
  };
  const migrated = migrateProject(old, [video]);
  assert.equal(migrated.version, 3);
  assert.ok(migrated.texts[0].track > migrated.clips[0].track);
  assert.ok(migrated.clips[0].track > migrated.clips[1].track);
  assert.ok(migrated.texts[1].track > migrated.texts[0].track);
  assert.deepEqual(migrated.hiddenTracks, [trackKey(migrated.texts[0])]);
  assert.deepEqual(migrated.mutedTracks, [trackKey(migrated.clips[0])]);
  const moved = moveToLayer(
    migrated,
    { kind: "text", id: migrated.texts[0].id },
    0,
  );
  const loaded = migrateProject(JSON.parse(JSON.stringify(moved)), [video]);
  assert.equal(
    loaded.texts[0].track,
    0,
    "Reload must not force text to the top",
  );
  assert.equal(loaded.texts[0].x, 0.3);
  assert.equal(loaded.texts[0].fontSize, 90);
  assert.equal(loaded.layerCount, moved.layerCount);
  assert.deepEqual(loaded.clips, moved.clips);
});
test("adding a bottom layer shifts all clip types and flags together", () => {
  const p = sampleProject();
  p.hiddenTracks = [trackKey(p.texts[0])];
  p.mutedTracks = [trackKey(p.clips[0])];
  const added = insertLayer(p, 0);
  assert.equal(added.layerCount, p.layerCount + 1);
  assert.equal(added.texts[0].track, p.texts[0].track + 1);
  assert.equal(added.clips[0].track, p.clips[0].track + 1);
  assert.deepEqual(added.hiddenTracks, [trackKey(added.texts[0])]);
  assert.deepEqual(added.mutedTracks, [trackKey(added.clips[0])]);
  assert.equal(
    p.clips[0].track,
    1,
    "Original project must remain unchanged for undo",
  );
});
test("undo/redo handles effects, typing groups and cancelled pointer transactions", () => {
  const p = sampleProject();
  let s = {
    project: p,
    past: [] as (typeof p)[],
    future: [] as (typeof p)[],
    origin: null as typeof p | null,
    group: "",
    at: 0,
  };
  s = historyReducer(s, {
    type: "edit",
    fn: (p) => ({ ...p, name: "A" }),
    group: "name",
    at: 1,
  });
  s = historyReducer(s, {
    type: "edit",
    fn: (p) => ({ ...p, name: "AB" }),
    group: "name",
    at: 300,
  });
  assert.equal(s.past.length, 1);
  s = historyReducer(s, { type: "undo" });
  assert.equal(s.project.name, p.name);
  s = historyReducer(s, { type: "redo" });
  assert.equal(s.project.name, "AB");
  s = historyReducer(s, { type: "begin" });
  s = historyReducer(s, {
    type: "preview",
    fn: (p) => ({ ...p, name: "dragged" }),
  });
  s = historyReducer(s, { type: "cancel" });
  assert.equal(s.project.name, "AB");
  s = historyReducer(s, { type: "begin" });
  s = historyReducer(s, {
    type: "preview",
    fn: (p) => ({ ...p, name: "moved" }),
  });
  s = historyReducer(s, { type: "commit" });
  assert.equal(s.past.length, 2);
  s = historyReducer(s, { type: "undo" });
  assert.equal(s.project.name, "AB");
});
test("export dimensions are codec-safe and preserve each canvas ratio", () => {
  assert.deepEqual(dimensions("16:9"), { width: 1920, height: 1080 });
  assert.deepEqual(dimensions("9:16"), { width: 1080, height: 1920 });
  assert.deepEqual(dimensions("4:5"), { width: 1080, height: 1350 });
});
test("property keyframes interpolate visual, text, effect and audio values and survive a split", () => {
  let clip = makeClip(video, 2);
  clip = setPropertyKeyframe(clip, "volume", 0, 0);
  clip = setPropertyKeyframe(clip, "volume", 4, 1);
  clip.effects = [{ name: "Glow", amount: 20 }];
  clip = setPropertyKeyframe(clip, "effect:Glow", 0, 0);
  clip = setPropertyKeyframe(clip, "effect:Glow", 4, 100);
  assert.ok(Math.abs(animatedItem(clip, 4).volume - 0.5) < 0.001);
  assert.ok(Math.abs(animatedItem(clip, 4).effects[0].amount - 50) < 0.001);
  let title = makeText(2, { color: "#000000" });
  title = setPropertyKeyframe(title, "color", 0, "#000000");
  title = setPropertyKeyframe(title, "color", 4, "#ffffff");
  assert.equal(animatedItem(title, 4).color, "#808080");
  title = togglePropertyKeyframe(title, "color", 4, "#ffffff");
  assert.equal(title.propertyKeyframes?.color.length, 1);
  const p = newProject(); p.assets = [video]; p.clips = [clip];
  const right = splitItem(p, { kind: "clip", id: clip.id }, 4).project.clips[1];
  assert.ok(Math.abs(animatedItem(right, 4).volume - animatedItem(clip, 4).volume) < 0.001);
});
test("Whisper words become readable, timed, editable caption clips", () => {
  const captions = wordsToCaptions([
    { text: "Hello", timestamp: [0, 0.4] },
    { text: "world!", timestamp: [0.4, 0.9] },
    { text: "Later", timestamp: [4, 4.5] },
  ], 12, 6, 3);
  assert.equal(captions.length, 2);
  assert.equal(captions[0].text, "Hello world!");
  assert.equal(captions[0].start, 12);
  assert.equal(captions[1].start, 16);
  assert.equal(captions[1].track, 3);
});
