import test from "node:test";
import assert from "node:assert/strict";
import { act, useReducer } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { GRADE_DEFAULTS, curveValue, gradeRgb, gradePixels, hasAdvancedGrade, identityCurves, normalizeGrade, resetGrade } from "../app/editor/colorGrading";
import { detectionCrop, detectionMask, normalizeDetections } from "../app/editor/objectDetection";
import { Inspector } from "../app/editor/Inspector";
import { animatedItem, makeClip, migrateProject, newProject, setPropertyKeyframe } from "../app/editor/model";
import { applyCodexEdits, projectRevision } from "../app/editor/codexEditing";
import { historyReducer } from "../app/editor/useProject";
const asset = { id: "source", name: "Source.png", kind: "image" as const, duration: 5, width: 200, height: 100, theme: "image", sizeLabel: "test" };
test("Neutral grading, bypass and old projects preserve colors, alpha and defaults", () => {
  assert.equal(hasAdvancedGrade({}), false); assert.equal(hasAdvancedGrade({ shadowHue: 300 }), false);
  assert.equal(hasAdvancedGrade({ exposure: 1 }), true); assert.equal(hasAdvancedGrade({ gradingEnabled: false, exposure: 1 }), false);
  assert.deepEqual(gradeRgb([.2, .4, .6], {}), [.2, .4, .6]);
  assert.deepEqual(gradeRgb([.2, .4, .6], { exposure: 2, gradingEnabled: false }), [.2, .4, .6]);
  const data = new Uint8ClampedArray([80, 90, 110, 77, 255, 0, 0, 0]); gradePixels(data, { exposure: 1 });
  assert.equal(data[3], 77); assert.equal(data[7], 0); assert.deepEqual([...data.slice(4)], [255, 0, 0, 0]);
  const old = newProject(); old.assets = [asset]; old.clips = [makeClip(asset)];
  const migrated = migrateProject(old, old.assets); assert.equal(hasAdvancedGrade(migrated.clips[0]), false); assert.deepEqual(normalizeGrade(migrated.clips[0]).colorCurves, identityCurves());
  const invalid = normalizeGrade({ exposure: Infinity, hue: 999, tint: -900, shadowStrength: NaN });
  assert.equal(invalid.exposure, 0); assert.equal(invalid.hue, 180); assert.equal(invalid.tint, -100); assert.equal(invalid.shadowStrength, 0);
});
test("Exposure, tonal controls, hue, vibrance, tint and three wheels produce meaningful changes", () => {
  assert.ok(Math.abs(gradeRgb([.2, .3, .4], { exposure: 1 })[0] - .4) < 1e-6);
  assert.ok(gradeRgb([.1, .1, .1], { shadows: 80 })[0] > .2);
  assert.ok(gradeRgb([.8, .8, .8], { highlights: -80 })[0] < .67);
  assert.ok(gradeRgb([.2, .4, .6], { tint: 100 })[1] < .4);
  assert.ok(gradeRgb([.2, .4, .6], { vibrance: 80 })[2] > .6);
  assert.notDeepEqual(gradeRgb([.6, .3, .2], { hue: 120 }), gradeRgb([.6, .3, .2], {}));
  for (const tone of ["shadow", "midtone", "highlight"]) {
    assert.notDeepEqual(gradeRgb([.4, .4, .4], { [`${tone}Hue`]: 0, [`${tone}Strength`]: 70 }), [.4, .4, .4]);
  }
  const curves = identityCurves(); curves.red = [{ x: 0, y: 0 }, { x: .5, y: .75 }, { x: 1, y: 1 }];
  assert.ok(gradeRgb([.5, .5, .5], { colorCurves: curves })[0] > .74);
  assert.ok(Math.abs(gradeRgb([.5, .5, .5], { colorCurves: curves })[1] - .5) < 1e-6);
});
test("Tone curves interpolate smoothly without overshooting and grade reset removes only grade automation", () => {
  const points = [{ x: 0, y: 0 }, { x: .3, y: .05 }, { x: .7, y: .95 }, { x: 1, y: 1 }];
  let previous = 0; for (let i = 0; i <= 1000; i++) { const value = curveValue(points, i / 1000); assert.ok(value >= previous - 1e-9 && value <= 1); previous = value; }
  const clip = setPropertyKeyframe(setPropertyKeyframe({ ...makeClip(asset), exposure: 2, colorCurves: identityCurves() }, "exposure", 0, 2), "opacity", 0, .7);
  const reset = resetGrade(clip); assert.equal(reset.exposure, 0); assert.equal(reset.propertyKeyframes?.exposure, undefined); assert.equal(reset.propertyKeyframes?.opacity.length, 1);
  assert.equal(clip.exposure, 2); assert.ok(clip.propertyKeyframes?.exposure);
});
test("Advanced grade is strictly AI-editable, scalar-keyframed and atomic", () => {
  const project = newProject(); project.assets = [asset]; project.clips = [makeClip(asset)]; const id = project.clips[0].id;
  const result = applyCodexEdits(project, { projectId: project.id, expectedRevision: projectRevision(project), operations: [
    { op: "update", id, exposure: 1.5, shadows: 25, tint: -12, highlightHue: 42, highlightStrength: 20, colorCurves: identityCurves() },
    { op: "keyframe", id, property: "exposure", at: 0, value: 0 }, { op: "keyframe", id, property: "exposure", at: 2, value: 2 },
  ] }).project;
  assert.equal(animatedItem(result.clips[0], 1).exposure, 1); assert.equal(result.clips[0].tint, -12);
  assert.throws(() => applyCodexEdits(project, { projectId: project.id, expectedRevision: projectRevision(project), operations: [{ op: "update", id, exposure: 100 }] }), /numeric range/);
  assert.equal(project.clips[0].exposure, GRADE_DEFAULTS.exposure);
});
test("Object results are validated and accurately mapped to existing source crops and contain/cover masks", () => {
  const object = { label: "cat", score: .9, box: { xmin: .1, ymin: .2, xmax: .5, ymax: .8 } };
  assert.equal(normalizeDetections([object, { ...object, score: .1 }, { ...object, box: { ...object.box, xmin: NaN } }]).length, 1);
  assert.equal(normalizeDetections([object, { ...object, score: .8 }, { ...object, label: "person" }]).length, 2, "Only same-class duplicates should be suppressed");
  assert.deepEqual(detectionCrop(object, { x: .2, y: .1, width: .5, height: .5 }, 0), { x: .25, y: .2, width: .2, height: .30000000000000004 });
  const contain = detectionMask(object, { width: 200, height: 100 }, { width: 160, height: 90 }, "contain");
  assert.ok(Math.abs(contain.maskX! - .3) < 1e-9); assert.ok(Math.abs(contain.maskWidth! - .4) < 1e-9);
  const cover = detectionMask(object, { width: 100, height: 200 }, { width: 160, height: 90 }, "cover");
  assert.ok(Math.abs(cover.maskY! - .5) < 1e-9); assert.ok(cover.maskHeight! > 2); assert.equal(cover.maskSpace, "content");
});
test("Chroma switch label and visual switch toggle the checkbox, not the diamond; undo, animation and locks work", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "http://unit.test" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element, IS_REACT_ACT_ENVIRONMENT: true });
  globalThis.requestAnimationFrame = () => 1; globalThis.cancelAnimationFrame = () => {};
  const project = newProject(); project.assets = [asset]; project.clips = [makeClip(asset)]; let observed = project;
  let dispatch: (action: Parameters<typeof historyReducer>[1]) => void = () => {};
  function Harness() {
    const [state, send] = useReducer(historyReducer, { project, past: [], future: [], origin: null, group: "", at: 0 }); observed = state.project; dispatch = send;
    return <Inspector project={state.project} selection={{ kind: "clip", id: project.clips[0].id }} time={1} clear={() => {}} edit={(fn) => send({ type: "edit", fn, group: "", at: Date.now() })} />;
  }
  const root = createRoot(dom.window.document.getElementById("root")!);
  const chromaKeys = () => observed.clips[0].propertyKeyframes?.chromaKey;
  try {
    await act(() => root.render(<Harness />));
    await act(() => [...dom.window.document.querySelectorAll<HTMLButtonElement>(".inspector-tabs button")].find((b) => b.textContent === "Mask")!.click());
    const toggle = () => [...dom.window.document.querySelectorAll<HTMLLabelElement>(".toggle-field")].find((e) => e.textContent?.includes("Remove a color"))!;
    await act(() => toggle().querySelector<HTMLSpanElement>(".switch")!.click());
    assert.equal(observed.clips[0].chromaKey, true); assert.equal(observed.clips[0].propertyKeyframes?.chromaKey, undefined, "Switch must not add an automation key");
    assert.equal(toggle().control, toggle().querySelector("input"));
    await act(() => dispatch({ type: "undo" })); assert.equal(observed.clips[0].chromaKey, false);
    await act(() => toggle().querySelector<HTMLSpanElement>(".field-label")!.click()); assert.equal(observed.clips[0].chromaKey, true);
    await act(() => toggle().querySelector<HTMLButtonElement>(".property-keyframe")!.click()); assert.equal(observed.clips[0].chromaKey, true); assert.equal(chromaKeys()?.length, 1);
    await act(() => toggle().querySelector<HTMLSpanElement>(".switch")!.click()); assert.equal(animatedItem(observed.clips[0], 1).chromaKey, false);
    await act(() => dispatch({ type: "load", project: { ...project, lockedTracks: ["layer:0"] } }));
    assert.equal(dom.window.document.querySelector<HTMLFieldSetElement>(".inspector-controls")!.disabled, true);
    await act(() => toggle().querySelector<HTMLSpanElement>(".switch")!.click()); assert.equal(observed.clips[0].chromaKey, false);
  } finally { await act(() => root.unmount()); dom.window.close(); }
});
