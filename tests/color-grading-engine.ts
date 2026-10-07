import { createElement, useReducer } from "react";
import { createRoot } from "react-dom/client";
import { Inspector } from "../app/editor/Inspector";
import { historyReducer } from "../app/editor/useProject";
import { Renderer } from "../app/editor/renderer";
import { ColorGradeRenderer, gradePixels, identityCurves } from "../app/editor/colorGrading";
import { makeClip, newProject, type Asset } from "../app/editor/model";
import { exportProject, exportFormats } from "../app/editor/media";
type Check = (name: string, fn: () => unknown) => Promise<void>;
const assert = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const wait = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
async function fixture() {
  const source = document.createElement("canvas"); source.width = 256; source.height = 144;
  const ctx = source.getContext("2d")!, data = ctx.createImageData(256, 144);
  for (let y = 0; y < 144; y++) for (let x = 0; x < 256; x++) {
    const at = (y * 256 + x) * 4; data.data[at] = x; data.data[at + 1] = 30 + Math.round(y * 1.3); data.data[at + 2] = 70 + x / 2; data.data[at + 3] = y > 125 ? 128 : 255;
  }
  ctx.putImageData(data, 0, 0);
  const image = new Image(); image.src = source.toDataURL(); await image.decode();
  const asset: Asset = { id: "grade", name: "Color.png", kind: "image", duration: 2, url: image.src, width: 256, height: 144, theme: "image", sizeLabel: "test" };
  const project = newProject(); project.background = "#000000"; project.assets = [asset]; project.clips = [makeClip(asset)];
  return { source, image, asset, project, sources: new Map([[project.clips[0].id, image]]) };
}
export async function runColorGradingChecks(check: Check) {
  await check("Advanced color grading GPU/CPU paths agree at full resolution and preserve transparent alpha", async () => {
    const { source } = await fixture(), render = new ColorGradeRenderer();
    const curves = identityCurves(); curves.master = [{ x: 0, y: 0 }, { x: .3, y: .2 }, { x: .75, y: .88 }, { x: 1, y: 1 }];
    const settings = { exposure: .35, tint: 12, shadows: 20, highlights: -25, whites: 13, blacks: -8, vibrance: 33, hue: 7,
      shadowHue: 215, shadowStrength: 15, midtoneHue: 30, midtoneStrength: 5, highlightHue: 42, highlightStrength: 12, colorCurves: curves };
    try {
      const expected = source.getContext("2d")!.getImageData(0, 0, 256, 144); gradePixels(expected.data, settings);
      const gpu = render.render(source, settings), comparison = document.createElement("canvas"); comparison.width = 256; comparison.height = 144;
      const ctx = comparison.getContext("2d", { willReadFrequently: true })!; ctx.drawImage(gpu, 0, 0);
      const actual = ctx.getImageData(0, 0, 256, 144).data;
      let worst = 0, alphaWorst = 0; for (let i = 0; i < actual.length; i++) {
        if (i % 4 === 3) alphaWorst = Math.max(alphaWorst, Math.abs(actual[i] - expected.data[i]));
        else worst = Math.max(worst, Math.abs(actual[i] - expected.data[i]));
      }
      assert(worst <= 4, `GPU color differs from CPU by ${worst}`); assert(alphaWorst === 0, "Grade altered source alpha");
      assert(gpu.width === 256 && gpu.height === 144, "Grade downgraded resolution");
      const first = [...actual]; ctx.clearRect(0, 0, 256, 144); ctx.drawImage(render.render(source, settings), 0, 0);
      assert(ctx.getImageData(0, 0, 256, 144).data.every((v, i) => v === first[i]), "Grade is not deterministic");
      assert(render.render(source, { gradingEnabled: false, exposure: 2 }) === source, "Bypass did not return original");
    } finally { render.dispose(); }
  });
  await check("Every advanced grading control affects shared renderer pixels and bypass restores the original frame", async () => {
    const { project, sources } = await fixture(), renderer = new Renderer(), target = document.createElement("canvas"); target.width = 256; target.height = 144;
    const context = target.getContext("2d", { willReadFrequently: true })!;
    try {
      renderer.draw(target, project, .5, sources); const baseline = context.getImageData(0, 0, 256, 144).data;
      const patches = [{ exposure: .8 }, { tint: 45 }, { highlights: -50 }, { shadows: 50 }, { whites: -50 }, { blacks: 50 }, { vibrance: 70 }, { hue: 50 },
        { shadowStrength: 50 }, { midtoneStrength: 50 }, { highlightStrength: 50 }, { shadowLuma: 50 }, { midtoneLuma: 50 }, { highlightLuma: 50 }];
      for (const patch of patches) {
        renderer.draw(target, { ...project, clips: [{ ...project.clips[0], ...patch }] }, .5, sources);
        const data = context.getImageData(0, 0, 256, 144).data; let changed = 0; for (let i = 0; i < data.length; i += 4) if (Math.abs(data[i] - baseline[i]) + Math.abs(data[i + 1] - baseline[i + 1]) + Math.abs(data[i + 2] - baseline[i + 2]) > 4) changed++;
        assert(changed > 1000, `${Object.keys(patch)[0]} had no meaningful effect`);
      }
      renderer.draw(target, { ...project, clips: [{ ...project.clips[0], exposure: 2, temperature: 60, filter: "B&W", brightness: 50, gradingEnabled: false }] }, .5, sources);
      assert(context.getImageData(0, 0, 256, 144).data.every((v, i) => v === baseline[i]), "Full grade bypass did not restore original");
    } finally { renderer.dispose(); }
  });
  await check("Clicking visible chroma key switch removes green in real preview and creates one undoable edit", async () => {
    const { project, sources } = await fixture(); const green = document.createElement("canvas"); green.width = 256; green.height = 144;
    const g = green.getContext("2d")!; g.fillStyle = "#00ff00"; g.fillRect(0, 0, 256, 144); g.fillStyle = "#dc3333"; g.fillRect(90, 45, 60, 60);
    const image = new Image(); image.src = green.toDataURL(); await image.decode(); sources.set(project.clips[0].id, image); project.background = "#0000ff";
    const host = document.createElement("div"); document.body.appendChild(host); const root = createRoot(host); let observed = project, undo = 0;
    function Harness() {
      const [state, action] = useReducer(historyReducer, { project, past: [], future: [], origin: null, group: "", at: 0 }); observed = state.project; undo = state.past.length;
      return createElement(Inspector, { project: state.project, selection: { kind: "clip", id: project.clips[0].id }, time: .5, clear: () => {}, edit: (fn) => action({ type: "edit", fn, group: "", at: Date.now() }) });
    }
    const renderer = new Renderer(), target = document.createElement("canvas"); target.width = 256; target.height = 144;
    try {
      root.render(createElement(Harness)); await wait(60);
      [...host.querySelectorAll<HTMLButtonElement>(".inspector-tabs button")].find((b) => b.textContent === "Mask")!.click(); await wait();
      [...host.querySelectorAll<HTMLLabelElement>(".toggle-field")].find((el) => el.textContent?.includes("Remove a color"))!.querySelector<HTMLElement>(".switch")!.click(); await wait();
      assert(observed.clips[0].chromaKey && undo === 1 && !observed.clips[0].propertyKeyframes?.chromaKey, "Visible switch activated diamond instead of checkbox");
      renderer.draw(target, { ...observed, clips: [{ ...observed.clips[0], exposure: .4, tint: 15 }] }, .5, sources);
      const blue = target.getContext("2d")!.getImageData(10, 10, 1, 1).data;
      assert(blue[2] > 245 && blue[1] < 5, "Green was not removed before grading");
      const red = target.getContext("2d")!.getImageData(110, 65, 1, 1).data; assert(red[0] > red[1] * 2, "Foreground removed or recolored incorrectly");
    } finally { root.unmount(); host.remove(); renderer.dispose(); }
  });
  await check("Advanced grading survives actual encoded video export", async () => {
    const { project } = await fixture(); project.clips = [{ ...project.clips[0], sourceEnd: 1.2, exposure: 1, tint: 25 }];
    const target = document.createElement("canvas"); target.width = 256; target.height = 144;
    const image = new Image(); image.src = project.assets[0].url!; await image.decode(); const renderer = new Renderer();
    renderer.draw(target, project, .3, new Map([[project.clips[0].id, image]])); renderer.dispose();
    const expected = target.getContext("2d")!.getImageData(110, 70, 1, 1).data;
    const format = exportFormats()[0]; assert(format, "No encoder available");
    const blob = await exportProject(project, { resolution: 720, fps: 30, mime: format.mime, onProgress() {}, signal: new AbortController().signal });
    const url = URL.createObjectURL(blob), video = document.createElement("video"); video.muted = true;
    try {
      await new Promise<void>((resolve, reject) => { video.onloadeddata = () => resolve(); video.onerror = () => reject(new Error("Graded export could not decode")); video.src = url; });
      await new Promise<void>((resolve) => { video.onseeked = () => resolve(); video.currentTime = .3; });
      target.getContext("2d")!.drawImage(video, 0, 0, 256, 144);
      const actual = target.getContext("2d")!.getImageData(110, 70, 1, 1).data;
      assert(Math.abs(expected[0] - actual[0]) + Math.abs(expected[1] - actual[1]) + Math.abs(expected[2] - actual[2]) < 35, "Encoded grade differs from preview");
    } finally { video.pause(); video.removeAttribute("src"); video.load(); URL.revokeObjectURL(url); }
  });
}
