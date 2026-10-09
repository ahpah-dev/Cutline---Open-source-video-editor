import { ALL_FORMATS, BlobSource, CanvasSink, Input } from "mediabunny";
import { createElement, useReducer } from "react";
import { createRoot } from "react-dom/client";
import { Inspector } from "../app/editor/Inspector";
import { drawProjectBackground } from "../app/editor/background";
import { dimensions, makeText, migrateProject, newProject, normalizeBackgroundFill } from "../app/editor/model";
import { Renderer } from "../app/editor/renderer";
import { exportFormats, exportProject } from "../app/editor/media";
import { historyReducer, persistable } from "../app/editor/useProject";
import { loadProject, saveProject } from "../app/editorStorage";

type Check = (name: string, run: () => unknown) => Promise<void>;
type Assert = (value: unknown, message: string) => void;
const wait = () => new Promise((resolve) => setTimeout(resolve, 30));
const canvasFor = (width: number, height: number) => {
  const canvas = Object.assign(document.createElement("canvas"), { width, height });
  canvas.getContext("2d", { willReadFrequently: true });
  return canvas;
};
const pixel = (canvas: HTMLCanvasElement | OffscreenCanvas, x: number, y: number) => [...canvas.getContext("2d")!.getImageData(x, y, 1, 1).data];
const fill = () => normalizeBackgroundFill({ mode: "linear", angle: 0, stops: [
  { id: "red", color: "#ff0000", position: 0 }, { id: "blue", color: "#0000ff", position: 1 },
] });

export async function runBackgroundChecks(check: Check, assert: Assert) {
  await check("Canvas gradients render smooth real pixels at every ratio, beneath text and through gaps", () => {
    const renderer = new Renderer();
    try {
      for (const ratio of ["16:9", "9:16", "1:1", "4:5"] as const) {
        const { width, height } = dimensions(ratio, 180), canvas = canvasFor(width, height);
        const p = { ...newProject(), ratio, backgroundFill: fill() };
        renderer.draw(canvas, p, 0, new Map());
        assert(pixel(canvas, 0, height / 2)[0] > 250 && pixel(canvas, width - 1, height / 2)[2] > 250, "Linear endpoints do not reach edges");
        const middle = pixel(canvas, Math.floor(width / 2), Math.floor(height / 2));
        assert(Math.abs(middle[0] - middle[2]) < 3 && middle[3] === 255, "Missing smooth opaque blend");
        const swatch = canvasFor(width, height); drawProjectBackground(swatch.getContext("2d")!, p, width, height);
        assert(pixel(swatch, 13, 27).join() === pixel(canvas, 13, 27).join(), "Inspector swatch differs from player");
        const title = makeText(0, { text: "BACKGROUND", duration: 1, fontSize: 180, fontFamily: "Arial" });
        renderer.draw(canvas, { ...p, texts: [title] }, .5, new Map());
        const pixels = canvas.getContext("2d")!.getImageData(0, 0, width, height).data;
        assert(pixels.some((v, i) => i % 4 === 1 && v > 200), "Text no longer renders above gradient");
        renderer.draw(canvas, { ...p, texts: [title] }, 2, new Map());
        assert(pixel(canvas, 13, 27).every((v, i) => Math.abs(v - pixel(swatch, 13, 27)[i]) <= 1), "Background disappears outside clip duration");
      }
    } finally { renderer.dispose(); }
  });
  await check("Radial backgrounds respect center/radius and solid mode preserves the old color", () => {
    const p = { ...newProject(), backgroundFill: { ...fill(), mode: "radial" as const, centerX: .25, centerY: .75, radius: .5 } };
    const canvas = canvasFor(400, 300), renderer = new Renderer();
    try {
      renderer.draw(canvas, p, 0, new Map());
      assert(pixel(canvas, 100, 225)[0] > 250, "Radial center misplaced");
      assert(pixel(canvas, 399, 0)[2] === 255, "Radial outer color missing");
      assert(Math.abs(pixel(canvas, 160, 225)[2] - pixel(canvas, 100, 285)[2]) <= 1, "Radial gradient stretched into ellipse");
      renderer.draw(canvas, { ...p, background: "#123456", backgroundFill: { ...p.backgroundFill, mode: "solid" } }, 0, new Map());
      assert(pixel(canvas, 100, 225).join() === "18,52,86,255", "Legacy solid background broken");
    } finally { renderer.dispose(); }
  });
  await check("Real background inspector changes controls, autosaves/reloads and reverses in one undo", async () => {
    const host = document.createElement("div"); document.body.appendChild(host);
    const initial = newProject(); let observed = initial;
    let send: (action: Parameters<typeof historyReducer>[1]) => void = () => {};
    function Harness() {
      const [state, dispatch] = useReducer(historyReducer, { project: initial, past: [], future: [], origin: null, group: "", at: 0 });
      observed = state.project; send = dispatch;
      return createElement(Inspector, { project: state.project, selection: null, time: 0, clear() {},
        edit: (fn, group) => dispatch({ type: "edit", fn, group: group ?? "", at: Date.now() }) });
    }
    const root = createRoot(host);
    const click = async (selector: string, text?: string) => {
      const button = [...host.querySelectorAll<HTMLButtonElement>(selector)].find((b) => !text || b.textContent === text);
      assert(button, `Missing ${selector}/${text}`); button!.click(); await wait();
    };
    const set = async (selector: string, value: string) => {
      const input = host.querySelector<HTMLInputElement>(selector)!; assert(input, `Missing ${selector}`);
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true })); input.dispatchEvent(new Event("change", { bubbles: true })); await wait();
    };
    try {
      root.render(createElement(Harness)); await wait();
      await click('[aria-label="Background fill type"] button', "Linear");
      await click('[aria-label="Background palettes"] button', "Sunset");
      await set('[aria-label="Background angle value"]', "213"); assert(observed.backgroundFill.angle === 213, "Angle did not update");
      await set('[aria-label="Stop 1 color"]', "#34a7cf"); assert(observed.backgroundFill.stops[0].color === "#34a7cf", "Color did not update");
      await click('[aria-label="Add background color stop"]'); assert(observed.backgroundFill.stops.length === 4, "Stop not added");
      await click('[aria-label="Background fill type"] button', "Radial");
      await set('[aria-label="Background center X value"]', "23");
      await set('[aria-label="Background center Y value"]', "71");
      await set('[aria-label="Background radius value"]', "145");
      assert(observed.backgroundFill.centerX === .23 && observed.backgroundFill.centerY === .71 && observed.backgroundFill.radius === 1.45, "Radial controls did not update");
      const original = JSON.stringify(observed.backgroundFill);
      await click('[aria-label="Reverse background colors"]');
      send({ type: "undo" }); await wait(); assert(JSON.stringify(observed.backgroundFill) === original, "Reverse was not undone in one step");
      await saveProject(persistable(observed), []);
      const saved = await loadProject(); assert(saved.project, "No saved project");
      assert(JSON.stringify(migrateProject(saved.project!, []).backgroundFill) === original, "Gradient lost on reload");
      const swatch = host.querySelector<HTMLCanvasElement>('[aria-label="Canvas background preview"]')!;
      const expected = canvasFor(swatch.width, swatch.height);
      drawProjectBackground(expected.getContext("2d")!, observed, expected.width, expected.height);
      assert(pixel(swatch, 100, 60).join() === pixel(expected, 100, 60).join(), "Controls did not redraw swatch");
    } finally { root.unmount(); host.remove(); }
  });
  await check("Encoded MP4/VP9/VP8 files retain linear and radial canvas gradients", async () => {
    for (const mode of ["linear", "radial"] as const) for (const format of exportFormats()) {
      const p = { ...newProject(), backgroundFill: { ...fill(), mode, centerX: .3, centerY: .7 }, texts: [makeText(0, { text: "", duration: .2, opacity: 0 })] };
      const blob = await exportProject(p, { resolution: 144, fps: 30, mime: format.mime,
        signal: new AbortController().signal, onProgress() {} });
      const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
      try {
        const track = await input.getPrimaryVideoTrack(); assert(track, "No encoded video");
        const decoded = await new CanvasSink(track!, { poolSize: 1 }).getCanvas(.1); assert(decoded, "No decoded gradient frame");
        const canvas = decoded!.canvas, expected = canvasFor(canvas.width, canvas.height), renderer = new Renderer();
        try { renderer.draw(expected, p, .1, new Map()); } finally { renderer.dispose(); }
        for (const [x, y] of [[20, 30], [100, 90], [220, 120]]) {
          const a = pixel(canvas, x, y), b = pixel(expected, x, y);
          assert(a.every((v, i) => Math.abs(v - b[i]) <= 8), `${format.label}/${mode}: preview/export mismatch ${a}/${b}`);
        }
      } finally { input.dispose(); }
    }
  });
}
