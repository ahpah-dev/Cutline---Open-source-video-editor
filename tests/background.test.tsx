import assert from "node:assert/strict";
import test from "node:test";
import { act, useReducer } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { drawProjectBackground } from "../app/editor/background";
import { Inspector } from "../app/editor/Inspector";
import { dimensions, migrateProject, newProject, normalizeBackgroundFill, type Project } from "../app/editor/model";
import { historyReducer, persistable } from "../app/editor/useProject";
import { applyCodexEdits, projectRevision, projectSnapshot } from "../app/editor/codexEditing";

test("Canvas gradients persist through project backups and old projects keep their solid backgrounds", () => {
  const p = newProject();
  p.backgroundFill = normalizeBackgroundFill({ mode: "radial", angle: 270, centerX: .25, centerY: .8, radius: 1.6,
    stops: [{ id: "red", position: 0, color: "#ff0000" }, { id: "green", position: .3, color: "#00ff00" }, { id: "blue", position: 1, color: "#0000ff" }] });
  assert.deepEqual(migrateProject(JSON.parse(JSON.stringify(persistable(p))), []).backgroundFill, p.backgroundFill);
  const legacy = migrateProject({ ...p, background: "#123456", backgroundFill: undefined }, []);
  assert.equal(legacy.background, "#123456"); assert.equal(legacy.backgroundFill.mode, "solid");
  const bad = normalizeBackgroundFill({ mode: "invalid", angle: NaN, centerX: -1, centerY: Infinity, radius: 0, stops: [null, { color: "bad" }] });
  assert.equal(bad.mode, "solid"); assert.equal(bad.angle, 135); assert.equal(bad.centerX, 0);
  assert.equal(bad.centerY, .5); assert.equal(bad.radius, .1); assert.equal(bad.stops.length, 2);
  const first = newProject(), second = newProject(); first.backgroundFill.stops[0].color = "#ff0000";
  assert.notEqual(first.backgroundFill.stops[0].color, second.backgroundFill.stops[0].color);
});

test("Background gradient geometry covers every aspect ratio, uses true radial circles and ordered stops", () => {
  const coords: number[][] = [], colors: [number, string][] = [];
  const paint = { addColorStop(position: number, color: string) { colors.push([position, color]); } };
  const ctx = { fillStyle: "", fillRect() {}, createLinearGradient(...args: number[]) { coords.push(args); return paint; },
    createRadialGradient(...args: number[]) { coords.push(args); return paint; } } as unknown as CanvasRenderingContext2D;
  const p = newProject(); p.backgroundFill.mode = "linear";
  for (const ratio of ["16:9", "9:16", "1:1", "4:5"] as const) {
    const { width: w, height: h } = dimensions(ratio, 320);
    for (const angle of [0, 45, 90, 135, 270, 360]) {
      drawProjectBackground(ctx, { ...p, backgroundFill: { ...p.backgroundFill, angle } }, w, h);
      const [x0, y0, x1, y1] = coords.at(-1)!;
      const dx = Math.cos(angle * Math.PI / 180), dy = Math.sin(angle * Math.PI / 180);
      const projections = [[0, 0], [w, 0], [w, h], [0, h]].map(([x, y]) => x * dx + y * dy);
      assert.ok(Math.abs(x0 * dx + y0 * dy - Math.min(...projections)) < 1e-7);
      assert.ok(Math.abs(x1 * dx + y1 * dy - Math.max(...projections)) < 1e-7);
    }
  }
  drawProjectBackground(ctx, { ...p, backgroundFill: { ...p.backgroundFill, mode: "radial", centerX: .2, centerY: .8, radius: 1.2 } }, 400, 300);
  assert.deepEqual(coords.at(-1), [80, 240, 0, 80, 240, 300]);
  assert.deepEqual(colors.slice(-2), p.backgroundFill.stops.map((stop) => [stop.position, stop.color]));
  drawProjectBackground(ctx, { ...p, backgroundFill: { ...p.backgroundFill, mode: "solid" } }, 400, 300);
  assert.equal(ctx.fillStyle, p.background);
});

test("AI can inspect and atomically edit canvas gradients without losing existing settings", () => {
  const p = newProject();
  const apply = (project: Project, patch: object) => applyCodexEdits(project, { projectId: project.id, expectedRevision: projectRevision(project),
    operations: [{ op: "project", patch }] }).project;
  const gradient = apply(p, { backgroundFill: { mode: "linear", angle: 90 } });
  const radial = apply(gradient, { backgroundFill: { mode: "radial", centerX: .2 } });
  assert.equal(radial.backgroundFill.angle, 90); assert.equal(radial.backgroundFill.centerX, .2);
  assert.deepEqual(projectSnapshot(radial).backgroundFill, radial.backgroundFill);
  const solid = apply(radial, { background: "#abcdef" });
  assert.equal(solid.backgroundFill.mode, "solid"); assert.deepEqual(solid.backgroundFill.stops, p.backgroundFill.stops);
  for (const invalid of [{ angle: 361 }, { radius: 0 }, { stops: [{ color: "#ff0000", position: 0 }] }, { stops: [{ color: "red", position: 0 }, { color: "#ffffff", position: 1 }] }, { bogus: true }])
    assert.throws(() => apply(radial, { name: "Should not apply", backgroundFill: invalid }));
  assert.equal(radial.name, p.name); assert.equal(p.backgroundFill.mode, "solid");
});

test("Background inspector supports palettes, eight editable stops, reverse, radial controls, solid toggle and undo", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "http://unit.test" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element, IS_REACT_ACT_ENVIRONMENT: true });
  const paint = { addColorStop() {} };
  dom.window.HTMLCanvasElement.prototype.getContext = (() => ({ fillRect() {}, createLinearGradient() { return paint; },
    createRadialGradient() { return paint; } })) as unknown as typeof dom.window.HTMLCanvasElement.prototype.getContext;
  let observed = newProject(), dispatch: (action: Parameters<typeof historyReducer>[1]) => void = () => {};
  const initial = observed;
  function Harness() {
    const [state, send] = useReducer(historyReducer, { project: initial, past: [], future: [], origin: null, group: "", at: 0 });
    observed = state.project; dispatch = send;
    return <Inspector project={state.project} selection={null} time={0} clear={() => {}}
      edit={(fn, group) => send({ type: "edit", fn, group: group ?? "", at: Date.now() })} />;
  }
  const root = createRoot(dom.window.document.getElementById("root")!);
  const click = async (selector: string, text?: string) => {
    const button = [...dom.window.document.querySelectorAll<HTMLButtonElement>(selector)].find((b) => !text || b.textContent === text);
    assert.ok(button, `Missing ${selector}/${text}`); await act(() => button.click());
  };
  try {
    await act(() => root.render(<Harness />));
    await click('[aria-label="Background fill type"] button', "Linear"); assert.equal(observed.backgroundFill.mode, "linear");
    await click('[aria-label="Background palettes"] button', "Sunset"); assert.equal(observed.backgroundFill.stops.length, 3);
    for (let i = 0; i < 5; i++) await click('[aria-label="Add background color stop"]');
    assert.equal(observed.backgroundFill.stops.length, 8);
    assert.equal(dom.window.document.querySelector<HTMLButtonElement>('[aria-label="Add background color stop"]')!.disabled, true);
    await click('[aria-label="Remove stop 4"]'); assert.equal(observed.backgroundFill.stops.length, 7);
    const before = structuredClone(observed.backgroundFill);
    await click('[aria-label="Reverse background colors"]'); assert.equal(observed.backgroundFill.stops[0].color, before.stops.at(-1)!.color);
    await act(() => dispatch({ type: "undo" })); assert.deepEqual(observed.backgroundFill, before);
    await act(() => dispatch({ type: "redo" })); assert.equal(observed.backgroundFill.stops[0].color, before.stops.at(-1)!.color);
    await click('[aria-label="Background fill type"] button', "Radial");
    assert.ok(dom.window.document.querySelector('[aria-label="Background radius"]'));
    const saved = structuredClone(observed.backgroundFill.stops);
    await click('[aria-label="Background fill type"] button', "Solid");
    assert.equal(observed.background, initial.background); assert.deepEqual(observed.backgroundFill.stops, saved);
    await click('[aria-label="Background fill type"] button', "Linear"); assert.deepEqual(observed.backgroundFill.stops, saved);
  } finally { await act(() => root.unmount()); dom.window.close(); }
});
