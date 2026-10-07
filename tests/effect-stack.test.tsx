import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act, useReducer } from "react";
import { createRoot } from "react-dom/client";
import { Inspector, applyInspectorPatch } from "../app/editor/Inspector";
import { moveEffect, pruneEffectKeyframes, resetEffect } from "../app/editor/effectStack";
import { animatedItem, makeClip, newProject, setPropertyKeyframe, type Project } from "../app/editor/model";
import { EFFECTS, TRANSITIONS } from "../app/editor/presets";
import { historyReducer } from "../app/editor/useProject";
import { applyCodexEdits, projectRevision } from "../app/editor/codexEditing";
import { clipInActiveTransition } from "../app/editor/transitionEditing";

const asset = { id: "image", name: "Scene.png", kind: "image" as const, duration: 4, sizeLabel: "1 KB", theme: "image" };
test("Canvas editing only blocks the participating visual clips within the actual transition window", () => {
  const project = newProject(); project.assets = [asset];
  const previous = { ...makeClip(asset), id: "previous", sourceEnd: 2 };
  const incoming = { ...makeClip(asset, 2), id: "incoming", transition: "Spin clockwise" as const, transitionDuration: 1 };
  const other = { ...makeClip(asset, 0, 2), id: "other" };
  project.clips = [previous, incoming, other];
  assert.equal(clipInActiveTransition(project, previous.id, 1.5), true);
  assert.equal(clipInActiveTransition(project, incoming.id, 2.4), true);
  assert.equal(clipInActiveTransition(project, other.id, 2), false);
  assert.equal(clipInActiveTransition(project, incoming.id, 2.5), false);
  assert.equal(clipInActiveTransition(project, previous.id, 1.4), false);
  assert.equal(clipInActiveTransition(project, "missing", 2), false);
});
function projectFixture() {
  const project = newProject(); project.assets = [asset];
  let clip = makeClip(asset); clip.effects = [{ name: "Wavy", amount: 40, waves: 7 }, { name: "Glow", amount: 30 }];
  clip = setPropertyKeyframe(clip, "effect:Wavy", 0, 20);
  clip = setPropertyKeyframe(clip, "effect:Wavy", 2, 80);
  clip = setPropertyKeyframe(clip, "opacity", 0, 0.8);
  project.clips = [clip]; return project;
}
test("Effect reorder, reset and removal preserve neighbouring settings and automation", () => {
  const clip = projectFixture().clips[0];
  const reordered = moveEffect(clip.effects, 0, 1);
  assert.deepEqual(reordered.map((effect) => effect.name), ["Glow", "Wavy"]);
  assert.deepEqual(clip.effects.map((effect) => effect.name), ["Wavy", "Glow"]);
  assert.equal(moveEffect(clip.effects, 0, -1), clip.effects);
  const reset = resetEffect(clip, "Wavy");
  assert.equal(reset.effects[0].amount, EFFECTS.find((effect) => effect.name === "Wavy")!.defaultAmount);
  assert.equal(reset.effects[0].waves, 4);
  assert.equal(reset.propertyKeyframes?.["effect:Wavy"], undefined);
  assert.ok(reset.propertyKeyframes?.opacity);
  const pruned = pruneEffectKeyframes(clip, [clip.effects[1]]);
  assert.equal(pruned.propertyKeyframes?.["effect:Wavy"], undefined);
  assert.equal(clip.propertyKeyframes?.["effect:Wavy"].length, 2);
  const current = animatedItem(clip, 1);
  const waves = applyInspectorPatch(clip, { effects: current.effects.map((effect) => effect.name === "Wavy" ? { ...effect, waves: 11 } : effect) }, 1, 30);
  assert.equal(waves.effects[0].waves, 11, "A keyed intensity must not discard other effect settings");
  assert.equal(waves.effects[0].amount, 40);
  assert.equal(waves.propertyKeyframes?.["effect:Wavy"].length, 2);
  const amount = applyInspectorPatch(waves, { effects: current.effects.map((effect) => effect.name === "Wavy" ? { ...effect, amount: 65, waves: 11 } : effect) }, 1, 30);
  assert.equal(animatedItem(amount, 1).effects[0].amount, 65);
  assert.equal(amount.propertyKeyframes?.["effect:Wavy"].length, 3);
});
test("Expanded catalogue is uniquely named, described, categorized and AI-editable", () => {
  assert.ok(EFFECTS.length >= 30); assert.ok(TRANSITIONS.length >= 40);
  assert.equal(new Set(EFFECTS.map((effect) => effect.name)).size, EFFECTS.length);
  assert.equal(new Set(TRANSITIONS.map((effect) => effect.name)).size, TRANSITIONS.length);
  const project = projectFixture(), id = project.clips[0].id;
  for (const effect of EFFECTS) {
    assert.ok(effect.description && effect.category); assert.ok(effect.defaultAmount > 0 && effect.defaultAmount <= 100);
    const result = applyCodexEdits(project, { projectId: project.id, expectedRevision: projectRevision(project), operations: [{ op: "effect", id, name: effect.name, amount: 35 }] }).project;
    assert.equal(result.clips[0].effects.find((item) => item.name === effect.name)?.amount, 35);
  }
  const changed = applyCodexEdits(project, { projectId: project.id, expectedRevision: projectRevision(project), operations: [{ op: "effect", id, name: "Wavy", waves: 9 }] }).project;
  assert.deepEqual(changed.clips[0].effects.map((effect) => effect.name), ["Wavy", "Glow"]);
  assert.equal(changed.clips[0].effects[0].amount, 40);
  const removed = applyCodexEdits(project, { projectId: project.id, expectedRevision: projectRevision(project), operations: [{ op: "effect", id, name: "Wavy", remove: true }] }).project;
  assert.equal(removed.clips[0].propertyKeyframes?.["effect:Wavy"], undefined);
  const audio = { ...project, clips: [{ ...project.clips[0], kind: "audio" as const }] };
  assert.throws(() => applyCodexEdits(audio, { projectId: audio.id, expectedRevision: projectRevision(audio), operations:
    [{ op: "project", patch: { name: "Must roll back" } }, { op: "effect", id, name: "Glow" }] }), /not an audio clip/);
  assert.equal(audio.name, project.name);
});
test("Effects inspector supports order/reset/remove, single undo, and respects locked layers", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "http://unit.test" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element, IS_REACT_ACT_ENVIRONMENT: true });
  globalThis.requestAnimationFrame = () => 1; globalThis.cancelAnimationFrame = () => {};
  const initial = projectFixture(); let observed = initial;
  let dispatch: (action: Parameters<typeof historyReducer>[1]) => void = () => {};
  function Harness() {
    const [state, send] = useReducer(historyReducer, { project: initial, past: [], future: [], origin: null, group: "", at: 0 });
    observed = state.project; dispatch = send;
    return <Inspector project={state.project} selection={{ kind: "clip", id: initial.clips[0].id }} time={1} clear={() => {}}
      edit={(fn, group) => send({ type: "edit", fn, group: group ?? "", at: Date.now() })} />;
  }
  const root = createRoot(dom.window.document.getElementById("root")!);
  const click = async (label: string) => {
    const button = dom.window.document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
    assert.ok(button, `Missing ${label}`); await act(() => button.click());
  };
  try {
    await act(() => root.render(<Harness />));
    const tab = [...dom.window.document.querySelectorAll<HTMLButtonElement>(".inspector-tabs button")].find((button) => button.textContent === "Effects")!;
    assert.ok(tab); await act(() => tab.click());
    await click("Move Wavy later");
    assert.deepEqual(observed.clips[0].effects.map((effect) => effect.name), ["Glow", "Wavy"]);
    assert.equal(observed.clips[0].effects[1].amount, 40);
    assert.equal(observed.clips[0].effects[1].waves, 7);
    assert.equal(observed.clips[0].propertyKeyframes?.["effect:Wavy"].length, 2, "Reorder must not add automation keys");
    assert.equal(animatedItem(observed.clips[0], 1).effects[1].amount, 50);
    await click("Reset Wavy");
    assert.equal(observed.clips[0].propertyKeyframes?.["effect:Wavy"], undefined);
    await act(() => dispatch({ type: "undo" }));
    assert.equal(observed.clips[0].effects[1].waves, 7);
    await click("Remove Wavy");
    assert.equal(observed.clips[0].propertyKeyframes?.["effect:Wavy"], undefined);
    await act(() => dispatch({ type: "undo" }));
    assert.deepEqual(observed.clips[0].effects.map((effect) => effect.name), ["Glow", "Wavy"]);
    const locked: Project = { ...observed, lockedTracks: ["layer:0"] };
    await act(() => dispatch({ type: "load", project: locked }));
    await click("Remove Wavy"); assert.equal(observed, locked);
  } finally {
    await act(() => root.unmount()); dom.window.close();
  }
});
