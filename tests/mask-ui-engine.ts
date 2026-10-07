import { createElement, useReducer } from "react";
import { createRoot } from "react-dom/client";
import { Inspector } from "../app/editor/Inspector";
import { Preview } from "../app/editor/Preview";
import { historyReducer } from "../app/editor/useProject";
import { animatedItem, makeClip, makeText, newProject, type Asset } from "../app/editor/model";

type Check = (name: string, fn: () => unknown) => Promise<void>;
const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
const wait = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

export async function runMaskUiChecks(check: Check) {
  await check("Mask inspector and canvas handles edit keyframes, cancel, undo and obey locked layers", async () => {
    const image = document.createElement("canvas"); image.width = 200; image.height = 100;
    image.getContext("2d")!.fillRect(0, 0, 200, 100);
    const asset: Asset = { id: "mask-ui", name: "mask.png", kind: "image", url: image.toDataURL(), duration: 5, width: 200, height: 100, sizeLabel: "test", theme: "image" };
    const fixture = newProject(); fixture.assets = [asset]; fixture.clips = [{ ...makeClip(asset), scale: .6, rotation: 30, flipX: true }];
    const host = document.createElement("div"); document.body.appendChild(host); const root = createRoot(host);
    let observed = fixture, undoCount = 0;
    let dispatch: (action: Parameters<typeof historyReducer>[1]) => void = () => {};
    function Harness() {
      const [history, action] = useReducer(historyReducer, { project: fixture, past: [], future: [], origin: null, group: "", at: 0 });
      observed = history.project; undoCount = history.past.length; dispatch = action;
      const selection = { kind: "clip" as const, id: fixture.clips[0].id };
      return createElement("div", {},
        createElement(Preview, { project: history.project, selection, select: () => {}, time: 1, setTime: () => {}, seek: () => {}, playing: false, setPlaying: () => {}, dispatch: action, onError: (message) => { throw new Error(message); } }),
        createElement(Inspector, { project: history.project, selection, time: 1, clear: () => {}, edit: (fn) => action({ type: "edit", fn, group: "", at: Date.now() }) }));
    }
    const button = (selector: string) => host.querySelector<HTMLButtonElement>(selector)!;
    try {
      root.render(createElement(Harness));
      for (let i = 0; i < 80 && !host.querySelector(".selection-box"); i++) await wait(20);
      const maskTab = [...host.querySelectorAll<HTMLButtonElement>(".inspector-tabs button")].find((el) => el.textContent === "Mask")!;
      assert(maskTab, "Mask tab missing"); maskTab.click(); await wait();
      [...host.querySelectorAll<HTMLButtonElement>(".mask-presets button")].find((el) => el.textContent?.trim() === "Ellipse")!.click(); await wait();
      assert(observed.clips[0].maskShape === "Ellipse", "Mask shape was not applied");
      button('[aria-label="Edit mask"]').click(); await frame();
      assert(host.querySelector(".mask-overlay"), "Mask overlay did not appear");
      button('[aria-label="Add maskX keyframe"]').click(); await wait();
      const canvas = host.querySelector<HTMLCanvasElement>(".preview-panel canvas")!;
      canvas.style.width = "800px"; canvas.style.height = "450px";
      const start = async (selector: string) => {
        await frame(); const handle = button(selector); handle.setPointerCapture = () => {};
        const rect = canvas.getBoundingClientRect();
        const x = rect.left + parseFloat(handle.style.left) / 100 * rect.width, y = rect.top + parseFloat(handle.style.top) / 100 * rect.height;
        handle.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 73, button: 0, buttons: 1, clientX: x, clientY: y }));
        return { x, y };
      };
      const pointer = (type: string, x: number, y: number) => canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 73, button: 0, buttons: type === "pointerup" ? 0 : 1, clientX: x, clientY: y }));
      const beforeUndo = undoCount, begin = await start('[aria-label="Move mask"]');
      pointer("pointermove", begin.x + 60, begin.y + 20); await frame();
      assert(Math.abs(animatedItem(observed.clips[0], 1).maskX! - .5) > .02, "Mask move did not update keyframed position");
      assert(observed.clips[0].x === 0 && observed.clips[0].y === 0, "Mask drag incorrectly moved the clip");
      pointer("pointerup", begin.x + 60, begin.y + 20); await wait();
      assert(undoCount === beforeUndo + 1, "Mask drag did not create exactly one undo step");
      dispatch({ type: "undo" }); await frame();
      assert(animatedItem(observed.clips[0], 1).maskX === .5, "Undo did not restore mask");
      const size = await start('[aria-label="Resize mask"]'); pointer("pointermove", size.x + 30, size.y + 20); await frame();
      assert(observed.clips[0].maskWidth !== 1 || observed.clips[0].maskHeight !== 1, "Mask size handle did nothing");
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); await frame();
      assert(observed.clips[0].maskWidth === 1 && observed.clips[0].maskHeight === 1, "Escape committed mask size");
      button('[aria-label="Reset mask"]').click(); await frame();
      assert(observed.clips[0].maskShape === "None" && !observed.clips[0].propertyKeyframes?.maskX, "Reset retained mask/keyframes");
      dispatch({ type: "load", project: { ...fixture, lockedTracks: ["layer:0"] } }); await frame();
      assert(host.querySelector<HTMLFieldSetElement>(".inspector-controls")!.disabled, "Locked inspector remained editable");
      const rect = canvas.getBoundingClientRect(); canvas.setPointerCapture = () => {};
      pointer("pointerdown", rect.left + rect.width / 2, rect.top + rect.height / 2); pointer("pointermove", rect.left + rect.width * .7, rect.top + rect.height * .6); pointer("pointerup", 0, 0); await frame();
      assert(observed.clips[0].x === 0 && observed.clips[0].y === 0, "Locked preview moved source");
    } finally { root.unmount(); host.remove(); }
  });
  await check("Text masks share the same inspector controls and animation diamonds", async () => {
    const fixture = newProject(); fixture.texts = [makeText(0, { text: "MASKED", track: 1 })];
    let observed = fixture;
    function Harness() {
      const [history, action] = useReducer(historyReducer, { project: fixture, past: [], future: [], origin: null, group: "", at: 0 }); observed = history.project;
      return createElement(Inspector, { project: history.project, selection: { kind: "text", id: fixture.texts[0].id }, time: 1, clear: () => {}, edit: (fn) => action({ type: "edit", fn, group: "", at: Date.now() }) });
    }
    const host = document.createElement("div"); document.body.appendChild(host); const root = createRoot(host);
    try {
      root.render(createElement(Harness)); await wait(60);
      [...host.querySelectorAll<HTMLButtonElement>(".inspector-tabs button")].find((el) => el.textContent === "Mask")!.click(); await wait();
      [...host.querySelectorAll<HTMLButtonElement>(".mask-presets button")].find((el) => el.textContent?.trim() === "Heart")!.click(); await wait();
      host.querySelector<HTMLButtonElement>('[aria-label="Add maskFeather keyframe"]')!.click(); await wait();
      assert(observed.texts[0].maskShape === "Heart" && observed.texts[0].propertyKeyframes?.maskFeather?.length === 1, "Text mask controls or keyframes failed");
    } finally { root.unmount(); host.remove(); }
  });
}
