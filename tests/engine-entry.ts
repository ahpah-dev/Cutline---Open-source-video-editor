import {
  newProject,
  makeClip,
  makeText,
  makeComboAnimation,
  COMBO_ANIMATIONS,
  dimensions,
  freezeFrame,
  type Asset,
} from "../app/editor/model";
import { Renderer, hitBounds } from "../app/editor/renderer";
import {
  EFFECTS,
  ANIMATIONS,
  FILTERS,
  TEXT_PRESETS,
  TRANSITIONS,
} from "../app/editor/presets";
import {
  MediaPool,
  exportProject,
  exportFormats,
  inspectFile,
} from "../app/editor/media";
import {
  loadProject,
  saveProject,
  saveMediaAsset,
  deleteMediaAsset,
  listProjects,
} from "../app/editorStorage";
import { persistable } from "../app/editor/useProject";
import { sampleProject, SAMPLE_ASSETS } from "./fixtures";
import { createElement, useReducer, useState } from "react";
import { createRoot } from "react-dom/client";
import Editor from "../app/Editor";
import { Inspector } from "../app/editor/Inspector";
import { Preview } from "../app/editor/Preview";
import { historyReducer } from "../app/editor/useProject";
import { FULL_CROP } from "../app/editor/crop";
import { decodeClipAudio } from "../app/editor/whisper";
import { waveformColumns, waveformFromBuffer } from "../app/editor/waveform";
import { runAudioReliabilityChecks } from "./audio-reliability";
import { runVisualCompositingTests } from "./visual-compositing-engine";
import { runMaskUiChecks } from "./mask-ui-engine";
import { runExpandedEffectsTests } from "./expanded-effects-engine";
import { runTransitionTests } from "./transitions-engine";
import { runSceneDetectionChecks } from "./scene-detection-engine";
import { runColorGradingChecks } from "./color-grading-engine";
import { runTextFontChecks } from "./text-fonts-engine";
import type { CodexEvent, CodexStatus, CodexToolRequest, CodexToolResult } from "../app/editor/codexTypes";

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};
const testCanvas = () => {
  const canvas = document.createElement("canvas");
  // Repeated pixel assertions must not switch the comparison target between
  // GPU and CPU rasterizers halfway through the animation matrix.
  canvas.getContext("2d", { willReadFrequently: true });
  return canvas;
};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const hash = (canvas: HTMLCanvasElement) => {
  const data = canvas
    .getContext("2d")!
    .getImageData(0, 0, canvas.width, canvas.height).data;
  let n = 2166136261;
  for (let i = 0; i < data.length; i += 13)
    n = Math.imul(n ^ data[i], 16777619);
  return n >>> 0;
};
const frameDifference = (a: HTMLCanvasElement, b: HTMLCanvasElement) => {
  const x = a.getContext("2d")!.getImageData(0, 0, a.width, a.height).data;
  const y = b.getContext("2d")!.getImageData(0, 0, b.width, b.height).data;
  let count = 0,
    max = 0,
    sum = 0;
  for (let i = 0; i < x.length; i++) {
    const d = Math.abs(x[i] - y[i]);
    if (d) count++;
    max = Math.max(max, d);
    sum += d;
  }
  return JSON.stringify({ count, max, mean: sum / x.length });
};
function sineWav(seconds: number) {
  const rate = 48000,
    frames = rate * seconds,
    bytes = new ArrayBuffer(44 + frames * 2),
    view = new DataView(bytes);
  const text = (offset: number, value: string) =>
    Array.from(value).forEach((c, i) =>
      view.setUint8(offset + i, c.charCodeAt(0)),
    );
  text(0, "RIFF");
  view.setUint32(4, bytes.byteLength - 8, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, frames * 2, true);
  for (let i = 0; i < frames; i++)
    view.setInt16(
      44 + i * 2,
      Math.sin((i / rate) * Math.PI * 880) * 12000,
      true,
    );
  return new File([bytes], "test-tone.wav", { type: "audio/wav" });
}
async function videoMetadata(blob: Blob) {
  const video = document.createElement("video"),
    url = URL.createObjectURL(blob);
  video.muted = true;
  video.preload = "auto";
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Encoded video did not load")),
        10000,
      );
      video.onloadeddata = () => {
        clearTimeout(timeout);
        resolve();
      };
      video.onerror = () => {
        clearTimeout(timeout);
        reject(new Error("Encoded video is not playable"));
      };
      video.src = url;
    });
    if (!Number.isFinite(video.duration)) {
      video.currentTime = 10000;
      await wait(200);
    }
    return {
      duration: video.duration,
      width: video.videoWidth,
      height: video.videoHeight,
    };
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}

export async function runEngineTests() {
  const passed: string[] = [],
    failures: string[] = [],
    details: Record<string, unknown> = {};
  const check = async (name: string, fn: () => unknown) => {
    try {
      await fn();
      passed.push(name);
    } catch (e) {
      failures.push(name + ": " + (e as Error).stack);
    }
  };
  const canvas = testCanvas();
  Object.assign(canvas, dimensions("16:9", 180));
  const renderer = new Renderer(),
    p = sampleProject(),
    c = p.clips[0];
  p.clips = [c];
  p.texts = [];
  await check("Every effect changes actual canvas pixels", () => {
    renderer.draw(canvas, p, 1, new Map());
    const baseline = hash(canvas);
    for (const e of EFFECTS) {
      renderer.draw(
        canvas,
        { ...p, clips: [{ ...c, effects: [{ name: e.name, amount: 75 }] }] },
        1,
        new Map(),
      );
      assert(hash(canvas) !== baseline, e.name + " does not render");
    }
  });
  await check("Wavy visibly distorts clips and produces repeatable preview/export frames", () => {
    const output = testCanvas();
    output.width = canvas.width;
    output.height = canvas.height;
    renderer.draw(canvas, p, 1.3, new Map());
    const original = hash(canvas);
    const wavy = { ...p, clips: [{ ...c, effects: [{ name: "Wavy" as const, amount: 85, waves: 4 }] }] };
    renderer.draw(canvas, wavy, 1.3, new Map());
    const distorted = hash(canvas);
    assert(distorted !== original, "Wavy did not warp the clip image");
    new Renderer().draw(output, wavy, 1.3, new Map());
    assert(hash(output) === distorted, "Wavy differs between preview and export");
    const moreWaves = { ...p, clips: [{ ...c, effects: [{ name: "Wavy" as const, amount: 85, waves: 11 }] }] };
    renderer.draw(canvas, moreWaves, 1.3, new Map());
    assert(hash(canvas) !== distorted, "Changing the Wavy count does not alter the distortion");
    renderer.draw(canvas, wavy, 1.7, new Map());
    assert(hash(canvas) !== distorted, "Wavy does not travel over time");
  });
  await check(
    "Every text effect renders without painting over the underlying video",
    () => {
      const text = makeText(0, {
        text: "New Text",
        fontSize: 300,
        color: "#a1c0ed",
        track: 2,
        shadowBlur: 0,
        shadowOffset: 0,
        padding: 0,
      });
      const project = { ...p, texts: [text] };
      renderer.draw(canvas, project, 1.3, new Map());
      const baseline = hash(canvas);
      const background = [
        ...canvas.getContext("2d")!.getImageData(2, 2, 1, 1).data,
      ];
      for (const e of EFFECTS) {
        renderer.draw(
          canvas,
          {
            ...project,
            texts: [{ ...text, effects: [{ name: e.name, amount: 80 }] }],
          },
          1.3,
          new Map(),
        );
        assert(hash(canvas) !== baseline, e.name + " has no effect on text");
        const corner = [
          ...canvas.getContext("2d")!.getImageData(2, 2, 1, 1).data,
        ];
        assert(
          JSON.stringify(corner) === JSON.stringify(background),
          e.name + " painted outside the text layer",
        );
      }
    },
  );
  await check("Linear and radial text gradients render real pixels consistently", () => {
    const text = makeText(0, {
      text: "GRADIENT", fontSize: 300, fontWeight: 900, track: 2,
      shadowBlur: 0, shadowOffset: 0,
      gradientStops: [
        { id: "a", position: 0, color: "#ff3322" },
        { id: "b", position: 0.45, color: "#facc33" },
        { id: "c", position: 1, color: "#226aff" },
      ],
    });
    const project = { ...p, clips: [], texts: [text] };
    const fill = (patch: Partial<typeof text>) => {
      renderer.draw(canvas, { ...project, texts: [{ ...text, ...patch }] }, 1, new Map());
      return hash(canvas);
    };
    const solid = fill({ fillMode: "solid", color: "#ffffff" });
    const horizontal = fill({ fillMode: "linear", gradientAngle: 0 });
    const vertical = fill({ fillMode: "linear", gradientAngle: 90 });
    const radial = fill({ fillMode: "radial", gradientCenterX: 0.2, gradientCenterY: 0.7, gradientRadius: 0.5 });
    assert(horizontal !== solid, "Linear fill is indistinguishable from a solid color");
    assert(vertical !== horizontal, "Changing the gradient angle has no effect");
    assert(radial !== horizontal, "Radial fill is indistinguishable from linear fill");
    const exportFrame = testCanvas();
    exportFrame.width = canvas.width; exportFrame.height = canvas.height;
    new Renderer().draw(exportFrame, { ...project, texts: [{ ...text, fillMode: "radial", gradientCenterX: 0.2, gradientCenterY: 0.7, gradientRadius: 0.5 }] }, 1, new Map());
    assert(hash(exportFrame) === radial, "Gradient pixels differ between preview and a fresh export renderer");
  });
  await check(
    "All entrance and exit text presets animate real pixels and settle between phases",
    () => {
      const text = makeText(0, {
        text: "New Text",
        fontSize: 260,
        shadowBlur: 0,
        shadowOffset: 0,
        track: 2,
      });
      const project = { ...p, clips: [], texts: [text] };
      renderer.draw(canvas, project, 2, new Map());
      const settled = hash(canvas);
      const output = testCanvas();
      output.width = canvas.width;
      output.height = canvas.height;
      for (const name of ANIMATIONS.filter((n) => n !== "None")) {
        const animated = {
          ...project,
          texts: [
            {
              ...text,
              animation: name,
              animationDuration: 1,
              exitAnimation: name,
              exitAnimationDuration: 1,
            },
          ],
        };
        for (const time of [0.2, 3.8]) {
          renderer.draw(canvas, animated, time, new Map());
          assert(hash(canvas) !== settled, name + " fails at " + time);
          new Renderer().draw(output, animated, time, new Map());
          assert(
            hash(canvas) === hash(output),
            name +
              " differs between preview and export " +
              frameDifference(canvas, output),
          );
        }
        renderer.draw(canvas, animated, 2, new Map());
        assert(hash(canvas) === settled, name + " does not settle at rest");
      }
    },
  );
  await check("Combo loops animate text and video throughout clips and match fresh export renders", () => {
    const output = testCanvas();
    output.width = canvas.width;
    output.height = canvas.height;
    const text = makeText(0, { text: "Combo", fontSize: 220, shadowBlur: 0, shadowOffset: 0, track: 2, duration: 5 });
    const videoProject = { ...p, clips: [{ ...c, comboAnimations: [] }], texts: [] };
    const textProject = { ...p, clips: [], texts: [text] };
    renderer.draw(canvas, videoProject, 0.37, new Map());
    const videoBaseline = hash(canvas);
    renderer.draw(canvas, textProject, 0.37, new Map());
    const textBaseline = hash(canvas);
    for (const name of COMBO_ANIMATIONS) {
      const layer = makeComboAnimation(name);
      const animatedVideo = { ...videoProject, clips: [{ ...c, comboAnimations: [layer] }] };
      const animatedText = { ...textProject, texts: [{ ...text, comboAnimations: [layer] }] };
      renderer.draw(canvas, animatedVideo, 0.37, new Map());
      assert(hash(canvas) !== videoBaseline, `Video ${name} did not animate`);
      new Renderer().draw(output, animatedVideo, 0.37, new Map());
      assert(hash(canvas) === hash(output), `Video ${name} preview differs from export`);
      renderer.draw(canvas, animatedText, 0.37, new Map());
      assert(hash(canvas) !== textBaseline, `Text ${name} did not animate`);
      new Renderer().draw(output, animatedText, 0.37, new Map());
      assert(hash(canvas) === hash(output), `Text ${name} preview differs from export`);
    }
  });
  await check("Tuned video Zoom and Drift animate preview/export pixels and hit bounds", () => {
    const base = { ...c, start: 0, sourceEnd: 4, animation: "Drift" as const, animationDuration: 1,
      animationSettings: { angle: 0, distance: 0.25 }, exitAnimation: "Zoom" as const,
      exitAnimationDuration: 1, exitAnimationSettings: { zoomDirection: "out" as const, zoomAmount: 0.8 } };
    const project = { ...p, clips: [base], texts: [] };
    const plain = { ...project, clips: [{ ...base, animation: "None" as const, exitAnimation: "None" as const }] };
    const other = testCanvas(); other.width = canvas.width; other.height = canvas.height;
    for (const time of [0.2, 3.8]) {
      renderer.draw(canvas, plain, time, new Map());
      const normal = hash(canvas);
      const bounds = renderer.draw(canvas, project, time, new Map());
      assert(hash(canvas) !== normal, `Video animation has no pixels at ${time}`);
      if (time < 1) assert(bounds[0].x > canvas.width / 2, "Drift direction did not move video right");
      else assert(bounds[0].width < canvas.width, "Zoom out did not shrink video");
      new Renderer().draw(other, project, time, new Map());
      assert(hash(canvas) === hash(other), "Animated video preview differs from export renderer");
    }
    const stacked = { ...base,
      animationStack: [
        { name: "Drift" as const, settings: { angle: 0, distance: 0.25, fade: false } },
        { name: "Zoom" as const, settings: { zoomDirection: "in" as const, zoomAmount: 0.6, fade: false } },
      ],
      exitAnimationStack: [
        { name: "Zoom" as const, settings: { zoomDirection: "out" as const, zoomAmount: 0.8 } },
        { name: "Wipe right" as const, settings: {} },
      ],
    };
    const stackProject = { ...project, clips: [stacked] };
    const enterBounds = renderer.draw(canvas, stackProject, 0.2, new Map());
    assert(enterBounds[0].x > canvas.width / 2 && enterBounds[0].width < canvas.width,
      "Stacked Drift and Zoom did not combine on video");
    renderer.draw(canvas, project, 3.8, new Map());
    const singleExit = hash(canvas);
    renderer.draw(canvas, stackProject, 3.8, new Map());
    assert(hash(canvas) !== singleExit, "Stacked exit Wipe did not change rendered video pixels");
    new Renderer().draw(other, stackProject, 3.8, new Map());
    assert(hash(canvas) === hash(other), "Stacked preview and export renderer differ");
  });
  await check(
    "Every color look renders and reset restores original pixels",
    () => {
      renderer.draw(canvas, p, 1, new Map());
      const baseline = hash(canvas);
      for (const f of FILTERS.filter((f) => f.name !== "Original")) {
        renderer.draw(
          canvas,
          { ...p, clips: [{ ...c, filter: f.name }] },
          1,
          new Map(),
        );
        assert(hash(canvas) !== baseline, f.name + " does not render");
      }
      renderer.draw(canvas, p, 1, new Map());
      assert(hash(canvas) === baseline, "Reset was not deterministic");
    },
  );
  await check(
    "Every catalog transition renders against the preceding clip at the cut midpoint",
    () => {
      const next = { ...makeClip(p.assets[1], 1, c.track), transitionDuration: 1 };
      const project = { ...p, clips: [{ ...c, sourceEnd: 1 }, next] };
      renderer.draw(canvas, project, 1, new Map());
      const baseline = hash(canvas);
      for (const t of TRANSITIONS.filter((t) => t.name !== "None")) {
        renderer.draw(
          canvas,
          {
            ...project,
            clips: [project.clips[0], { ...next, transition: t.name }],
          },
          1,
          new Map(),
        );
        assert(hash(canvas) !== baseline, t.name + " does not render");
      }
    },
  );
  await check("Transitions straddle the cut and blend both clips, including their outgoing tail", () => {
    const outgoing = { ...makeClip(p.assets[0], 0, 1), sourceEnd: 1 };
    const incoming = { ...makeClip(p.assets[1], 1, 1), sourceEnd: 2, transition: "Dissolve" as const, transitionDuration: 0.8 };
    const project = { ...p, clips: [outgoing, incoming], texts: [] };
    const sourceOnly = { ...project, clips: [outgoing] };
    renderer.draw(canvas, sourceOnly, 0.8, new Map());
    const previousFrame = hash(canvas);
    renderer.draw(canvas, project, 0.8, new Map());
    assert(hash(canvas) !== previousFrame, "Incoming clip is absent before the cut");
    renderer.draw(canvas, project, 1.2, new Map());
    const blendTail = hash(canvas);
    renderer.draw(canvas, { ...project, clips: [incoming] }, 1.2, new Map());
    assert(blendTail !== hash(canvas), "Outgoing clip is absent after the cut");
    for (const [name, channel] of [["Fade black", 0], ["Fade white", 255]] as const) {
      renderer.draw(canvas, { ...project, clips: [outgoing, { ...incoming, transition: name }] }, 1, new Map());
      const pixel = canvas.getContext("2d")!.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data;
      assert(Math.abs(pixel[0] - channel) < 2 && Math.abs(pixel[1] - channel) < 2 && Math.abs(pixel[2] - channel) < 2,
        `${name} does not pass through its ${channel ? "white" : "black"} midpoint`);
    }
    const exportCanvas = testCanvas(); exportCanvas.width = canvas.width; exportCanvas.height = canvas.height;
    renderer.draw(canvas, project, 1.2, new Map());
    new Renderer().draw(exportCanvas, project, 1.2, new Map());
    assert(hash(canvas) === hash(exportCanvas), "Join preview differs from export renderer");
  });
  await check("Imported images fit their selection bounds and cropped media cannot spill outside them", async () => {
    const picture = testCanvas(); picture.width = 80; picture.height = 160;
    picture.getContext("2d")!.fillStyle = "#ff0000";
    picture.getContext("2d")!.fillRect(0, 0, 80, 160);
    const image = new Image(); image.src = picture.toDataURL(); await image.decode();
    const asset: Asset = { id: "portrait", kind: "image", name: "portrait.png", duration: 5, width: 80, height: 160, sizeLabel: "1 KB", theme: "image" };
    const clip = makeClip(asset);
    const project = newProject(); project.assets = [asset]; project.clips = [clip];
    const sources = new Map([[clip.id, image]]);
    assert(clip.fit === "contain", "New image starts cropped instead of fitted");
    let bounds = renderer.draw(canvas, project, 1, sources);
    assert(Math.abs(bounds[0].width - canvas.height / 2) < 1, "Fit-inside selection width does not match visible image");
    assert(Math.abs(bounds[0].height - canvas.height) < 1, "Fit-inside selection height does not match visible image");
    const reduced = { ...clip, fit: "cover" as const, scale: 0.25 };
    bounds = renderer.draw(canvas, { ...project, clips: [reduced] }, 1, sources);
    assert(Math.abs(bounds[0].width - canvas.width * 0.25) < 1, "Fill-frame selection width is wrong");
    const outside = canvas.getContext("2d")!.getImageData(canvas.width / 2, canvas.height / 2 - bounds[0].height / 2 - 8, 1, 1).data;
    assert(outside[0] < 20, "Cropped image escapes its selection frame");
  });
  await check("Transparent incoming transitions fade the outgoing frame smoothly to zero", async () => {
    const outgoingPicture = testCanvas(); outgoingPicture.width = 320; outgoingPicture.height = 180;
    outgoingPicture.getContext("2d")!.fillStyle = "#ff0000";
    outgoingPicture.getContext("2d")!.fillRect(0, 0, 320, 180);
    const incomingPicture = testCanvas(); incomingPicture.width = 320; incomingPicture.height = 180;
    incomingPicture.getContext("2d")!.fillStyle = "#0000ff";
    incomingPicture.getContext("2d")!.fillRect(0, 0, 160, 180);
    const firstImage = new Image(); firstImage.src = outgoingPicture.toDataURL(); await firstImage.decode();
    const secondImage = new Image(); secondImage.src = incomingPicture.toDataURL(); await secondImage.decode();
    const firstAsset: Asset = { id: "red", kind: "image", name: "red.png", duration: 2, width: 320, height: 180, sizeLabel: "1 KB", theme: "image" };
    const secondAsset: Asset = { ...firstAsset, id: "blue", name: "blue.png" };
    const first = { ...makeClip(firstAsset, 0, 0), sourceEnd: 1 };
    const second = { ...makeClip(secondAsset, 1, 0), sourceEnd: 1, transition: "Dissolve" as const, transitionDuration: 1 };
    const project = newProject(); project.assets = [firstAsset, secondAsset]; project.clips = [first, second];
    const sources = new Map([[first.id, firstImage], [second.id, secondImage]]);
    const redAt = (time: number) => {
      renderer.draw(canvas, project, time, sources);
      return canvas.getContext("2d")!.getImageData(canvas.width * 0.75, canvas.height / 2, 1, 1).data[0];
    };
    const early = redAt(0.6), middle = redAt(1), late = redAt(1.4), after = redAt(1.5);
    assert(early > middle && middle > late && late < 20 && after < 20 && late - after < 12,
      `Outgoing image pops at the end: ${early}, ${middle}, ${late}, ${after}`);
  });
  await check("Transition duration is editable before choosing a style", async () => {
    const fixture = newProject(); fixture.assets = [SAMPLE_ASSETS[0]];
    const first = { ...makeClip(SAMPLE_ASSETS[0], 0, 0), sourceEnd: 2 };
    const second = { ...makeClip(SAMPLE_ASSETS[0], 2, 0), sourceEnd: 2 };
    fixture.clips = [first, second];
    const host = document.createElement("div"); document.body.appendChild(host);
    const root = createRoot(host);
    let observed = fixture;
    function Harness() {
      const [project, setProject] = useState(fixture);
      observed = project;
      return createElement(Inspector, { project, selection: { kind: "clip", id: second.id }, time: 2, clear: () => {}, edit: (fn) => setProject((p) => fn(p)) });
    }
    try {
      root.render(createElement(Harness));
      for (let i = 0; i < 30 && !host.querySelector('[aria-label="Duration value"]'); i++) await wait(20);
      const input = host.querySelector<HTMLInputElement>('[aria-label="Duration value"]');
      assert(input && observed.clips[1].transition === "None", "Duration is hidden until a transition is applied");
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "0.8");
      input!.dispatchEvent(new Event("input", { bubbles: true })); await wait(30);
      assert(Math.abs(observed.clips[1].transitionDuration - 0.8) < 0.001, "Duration input does not save edits");
    } finally { root.unmount(); host.remove(); }
  });
  await check(
    "Text presets render, return hit bounds, and respect hidden tracks",
    () => {
      renderer.draw(canvas, p, 1, new Map());
      const baseline = hash(canvas);
      for (const preset of TEXT_PRESETS) {
        const text = makeText(0, {
          text: preset.sample,
          ...preset.style,
          track: c.track + 1,
        });
        const bounds = renderer.draw(
          canvas,
          { ...p, texts: [text] },
          2,
          new Map(),
        );
        const bound = bounds.find((b) => b.id === text.id)!;
        assert(hash(canvas) !== baseline, preset.name + " invisible");
        assert(
          hitBounds(bounds, bound.x, bound.y)?.id === text.id,
          preset.name + " hit test fails",
        );
      }
      const text = makeText(0, { track: c.track + 1 });
      renderer.draw(
        canvas,
        { ...p, texts: [text], hiddenTracks: [`layer:${text.track}`] },
        1,
        new Map(),
      );
      assert(hash(canvas) === baseline, "Hidden text still renders");
    },
  );
  await check(
    "Universal layers composite text behind and in front of video, including hit testing",
    () => {
      const video = { ...c, track: 1, start: 0 };
      const text = makeText(0, {
        text: "BEHIND VIDEO",
        track: 0,
        fontSize: 160,
      });
      const project = {
        ...p,
        clips: [video],
        texts: [] as ReturnType<typeof makeText>[],
      };
      renderer.draw(canvas, project, 1, new Map());
      const opaque = hash(canvas);
      const behind = { ...project, texts: [text] };
      let bounds = renderer.draw(canvas, behind, 1, new Map());
      assert(
        hash(canvas) === opaque,
        "Text below opaque video must be occluded",
      );
      assert(
        hitBounds(bounds, canvas.width / 2, canvas.height / 2)?.id === video.id,
        "Video must be hit before text behind it",
      );
      const front = { ...project, texts: [{ ...text, track: 2 }] };
      bounds = renderer.draw(canvas, front, 1, new Map());
      assert(hash(canvas) !== opaque, "Moving text above video must reveal it");
      assert(
        hitBounds(bounds, canvas.width / 2, canvas.height / 2)?.id === text.id,
        "Front text must be hit first",
      );
      const reduced = { ...behind, clips: [{ ...video, scale: 0.35 }] };
      renderer.draw(canvas, reduced, 1, new Map());
      const visibleBehind = hash(canvas);
      renderer.draw(canvas, { ...reduced, texts: [] }, 1, new Map());
      assert(
        hash(canvas) !== visibleBehind,
        "Text behind a smaller video must remain visible around it",
      );
      const output = testCanvas();
      output.width = canvas.width;
      output.height = canvas.height;
      for (const state of [behind, front, reduced]) {
        renderer.draw(canvas, state, 1, new Map());
        new Renderer().draw(output, state, 1, new Map());
        assert(
          hash(canvas) === hash(output),
          "Preview/export layer order diverged " +
            frameDifference(canvas, output),
        );
      }
    },
  );
  await check(
    "Preview and export renderer instances produce identical frames",
    () => {
      const a = testCanvas();
      a.width = canvas.width;
      a.height = canvas.height;
      const project = {
        ...p,
        clips: [
          {
            ...c,
            effects: [
              { name: "Grain" as const, amount: 60 },
              { name: "Glow" as const, amount: 45 },
            ],
            scale: 0.8,
            rotation: 12,
          },
        ],
        texts: [
          makeText(0, { animation: "Pop", strokeWidth: 4, background: true }),
        ],
      };
      renderer.draw(canvas, project, 1.2, new Map());
      new Renderer().draw(a, project, 1.2, new Map());
      assert(
        hash(a) === hash(canvas),
        "Renderer output differs " + frameDifference(a, canvas),
      );
    },
  );
  let audio: Asset | null = null;
  const wav = sineWav(2);
  await check(
    "Audio import reads duration and generates a real waveform",
    async () => {
      audio = await inspectFile(wav);
      assert(Math.abs(audio.duration - 2) < 0.01, "Wrong WAV duration");
      assert(
        audio.waveform?.some((v) => v > 0.1),
        "Waveform missing",
      );
      assert((audio.waveform?.length ?? 0) >= 1024, "Waveform is too coarse for timeline zoom");
      assert(audio.waveformPeaks?.length === audio.waveform?.length, "Peak envelope is missing");
    },
  );
  await check("Waveform follows real level changes and source-time zoom", async () => {
    const buffer = new AudioBuffer({ length: 96000, numberOfChannels: 2, sampleRate: 48000 });
    const first = buffer.getChannelData(0);
    const second = buffer.getChannelData(1);
    for (let i = 0; i < first.length; i++) {
      const amplitude = i < 48000 ? 0.06 : 0.8;
      first[i] = Math.sin(i / 12) * amplitude;
      second[i] = Math.sin(i / 12) * amplitude * 0.6;
    }
    const analyzed = waveformFromBuffer(buffer);
    const quiet = waveformColumns(analyzed.waveform, analyzed.waveformPeaks, 0, 1, 2, 200);
    const loud = waveformColumns(analyzed.waveform, analyzed.waveformPeaks, 1, 2, 2, 200);
    assert(loud[100].rms > quiet[100].rms * 8, "RMS envelope ignores actual audio dynamics");
    assert(loud[100].peak > quiet[100].peak * 8, "Peak envelope ignores transients");
    assert(quiet.length === loud.length, "Waveform changed density with source trim");
  });
  await check(
    "Project storage preserves old projects and embedded media",
    async () => {
      const first = sampleProject(),
        second = newProject();
      if (audio) {
        first.assets.push(audio);
        await saveMediaAsset({ ...audio, kind: "audio", blob: wav });
      }
      await saveProject(persistable(first));
      await saveProject(persistable(second));
      const loaded = await loadProject(),
        projects = await listProjects();
      assert(
        loaded.project &&
          "id" in loaded.project &&
          loaded.project.id === second.id,
        "Current project not restored",
      );
      assert(
        projects.some((p) => "id" in p && p.id === first.id),
        "Previous project was lost",
      );
      assert(
        loaded.media.some(
          (m) => m.id === audio?.id && m.blob.size === wav.size,
        ),
        "Media was deleted",
      );
    },
  );
  const formats = exportFormats();
  details.formats = formats;
  assert(formats.length, "No video encoder");
  const exportP = newProject();
  exportP.assets = SAMPLE_ASSETS.map((a) => ({ ...a }));
  exportP.clips = [{ ...makeClip(exportP.assets[0]), sourceEnd: 0.8 }];
  exportP.texts = [
    makeText(1.2, {
      text: "TAIL FRAME",
      duration: 1,
      animation: "Bounce",
      animationDuration: 0.25,
      exitAnimation: "Spin",
      exitAnimationDuration: 0.35,
      fillMode: "linear",
      gradientAngle: 35,
      gradientStops: [
        { id: "first", position: 0, color: "#ffe08e" },
        { id: "middle", position: 0.5, color: "#fc8b8a" },
        { id: "last", position: 1, color: "#b885ff" },
      ],
      effects: [{ name: "Glow", amount: 70 }],
    }),
  ];
  if (audio) {
    exportP.assets.push(audio);
    exportP.clips.push({
      ...makeClip(audio, 0.2),
      sourceEnd: 1.8,
      volume: 0.6,
      fadeIn: 0.1,
      fadeOut: 0.1,
    });
  }
  let output: Blob | null = null;
  for (const format of formats)
    await check(
      "Real " +
        format.label +
        " export is playable, dimensioned and includes the tail",
      async () => {
        const start = performance.now();
        const blob = await exportProject(exportP, {
          resolution: 720,
          fps: 30,
          mime: format.mime,
          signal: new AbortController().signal,
          onProgress() {},
        });
        const metadata = await videoMetadata(blob);
        details[format.label] = {
          ...metadata,
          bytes: blob.size,
          elapsedMs: performance.now() - start,
        };
        assert(blob.size > 10000, "Suspiciously small video");
        assert(
          metadata.width === 1280 && metadata.height === 720,
          "Wrong export dimensions",
        );
        assert(
          Number.isFinite(metadata.duration) &&
            metadata.duration >= 2.1 &&
            metadata.duration < 3,
          "Export duration is wrong: " + metadata.duration,
        );
        output ??= blob;
      },
    );
  await check("Encoded output contains audible mixed audio", async () => {
    assert(output, "No encoded output");
    const context = new AudioContext();
    try {
      const buffer = await context.decodeAudioData(await output!.arrayBuffer());
      const samples = buffer.getChannelData(0);
      let max = 0;
      for (const v of samples) max = Math.max(max, Math.abs(v));
      assert(max > 0.05, "Audio is silent");
      details.audioPeak = max;
    } finally {
      await context.close();
    }
  });
  await check(
    "Cancel stops immediately and a subsequent export works",
    async () => {
      const controller = new AbortController();
      let abortedAt = 0,
        cancelled = false;
      try {
        await exportProject(exportP, {
          resolution: 720,
          fps: 30,
          mime: formats[0].mime,
          signal: controller.signal,
          onProgress(progress) {
            if (progress > 0.08 && !controller.signal.aborted) {
              abortedAt = performance.now();
              controller.abort();
            }
          },
        });
      } catch (e) {
        cancelled = (e as Error).name === "AbortError";
      }
      assert(cancelled, "Export did not cancel");
      assert(
        performance.now() - abortedAt < 1000,
        "Cancellation took too long",
      );
      const brief = { ...exportP, texts: [], clips: [exportP.clips[0]] };
      const blob = await exportProject(brief, {
        resolution: 720,
        fps: 30,
        mime: formats[0].mime,
        signal: new AbortController().signal,
        onProgress() {},
      });
      assert(blob.size > 1000, "Export did not recover after cancel");
    },
  );
  await check(
    "Duplicate video clips keep independent source positions",
    async () => {
      assert(output, "No encoded video");
      const asset = await inspectFile(
        new File([output!], "rendered.mp4", { type: output!.type }),
      );
      const p = newProject();
      p.assets.push(asset);
      p.clips = [
        { ...makeClip(asset), sourceEnd: 0.8 },
        { ...makeClip(asset, 0, 1), sourceStart: 1.2, sourceEnd: 2.2 },
      ];
      const pool = new MediaPool();
      try {
        await pool.ensure(p);
        await pool.sync(p, 0.25, false);
        const a = pool.sources.get(p.clips[0].id) as HTMLVideoElement,
          b = pool.sources.get(p.clips[1].id) as HTMLVideoElement;
        assert(a !== b, "Duplicate clips share the same player");
        assert(
          Math.abs(a.currentTime - 0.25) < 0.03 &&
            Math.abs(b.currentTime - 1.45) < 0.03,
          "Source offsets are wrong",
        );
      } finally {
        pool.dispose();
        URL.revokeObjectURL(asset.url!);
      }
    },
  );
  await check("Real video transitions seek both source handles and crossfade their audio", async () => {
    assert(output, "No encoded video");
    const asset = await inspectFile(new File([output!], "transition-source.mp4", { type: output!.type }));
    const project = newProject(); project.assets = [asset];
    const outgoing = { ...makeClip(asset, 0, 1), sourceStart: 0.2, sourceEnd: 1 };
    const incoming = { ...makeClip(asset, 0.8, 1), sourceStart: 1, sourceEnd: 1.8,
      transition: "Dissolve" as const, transitionDuration: 0.4 };
    project.clips = [outgoing, incoming];
    const pool = new MediaPool();
    try {
      await pool.ensure(project);
      await pool.enableAudio(true);
      for (const [time, outGain, inGain] of [[0.7, 0.75, 0.25], [0.9, 0.25, 0.75]]) {
        await pool.sync(project, time, false);
        const first = pool.sources.get(outgoing.id) as HTMLVideoElement;
        const second = pool.sources.get(incoming.id) as HTMLVideoElement;
        assert(Math.abs(first.currentTime - (outgoing.sourceStart + time)) < 0.04,
          "Outgoing video did not seek through the join");
        assert(Math.abs(second.currentTime - (incoming.sourceStart + time - incoming.start)) < 0.04,
          "Incoming video did not seek before/after the cut");
        const gains = (pool as unknown as { gains: Map<string, GainNode> }).gains;
        assert(Math.abs(gains.get(outgoing.id)!.gain.value - outGain) < 0.02 &&
          Math.abs(gains.get(incoming.id)!.gain.value - inGain) < 0.02,
          "Embedded clip audio is not crossfaded between both sources");
      }
    } finally {
      pool.dispose();
      URL.revokeObjectURL(asset.url!);
    }
  });
  await check("Freeze frame holds a decoded video frame during playback and export sync", async () => {
    assert(output, "No encoded video");
    const asset = await inspectFile(new File([output!], "freeze-source.mp4", { type: output!.type }));
    const p = newProject();
    p.assets = [asset];
    const source = { ...makeClip(asset), sourceEnd: Math.min(asset.duration, 1.5) };
    p.clips = [source];
    const result = freezeFrame(p, { kind: "clip", id: source.id }, 0.4);
    assert(result.project !== p, "Freeze was not inserted");
    const frozen = result.project.clips.find((c) => c.id === result.selection?.id)!;
    const pool = new MediaPool();
    try {
      await pool.ensure(result.project);
      await pool.sync(result.project, frozen.start + 0.1, true);
      const player = pool.sources.get(frozen.id) as HTMLVideoElement;
      assert(Math.abs(player.currentTime - frozen.frozenAt!) < 0.03, "Freeze seeks to the chosen source frame");
      assert(player.paused, "Freeze should not continue playing source video or audio");
      await pool.sync(result.project, frozen.start + 1.8, true);
      assert(Math.abs(player.currentTime - frozen.frozenAt!) < 0.03 && player.paused, "Freeze drifted over time");
    } finally {
      pool.dispose();
      URL.revokeObjectURL(asset.url!);
    }
  });
  await check("Whisper decodes stored media even when its preview URL is stale", async () => {
    assert(output, "No encoded MP4 source");
    const asset = await inspectFile(new File([output!], "subtitle-source.mp4", { type: output!.type }));
    try {
      const clip = { ...makeClip(asset), sourceStart: 0, sourceEnd: 2 };
      const samples = await decodeClipAudio(clip, asset);
      assert(samples.length >= 31900 && samples.length <= 32100, `Expected 2s of 16 kHz input, got ${samples.length}`);
      assert(samples.some((sample) => Math.abs(sample) > 0.001), "Whisper input is silent despite audible source");
      const { url: _previewUrl, ...stored } = asset;
      void _previewUrl;
      await saveMediaAsset({ ...stored, kind: "video", blob: output! });
      const restored = await decodeClipAudio(clip, { ...asset, url: "blob:stale-preview-url" });
      assert(restored.length === samples.length && restored.some((sample) => Math.abs(sample) > 0.001), "Stored media was not decoded after the preview URL expired");
    } finally {
      await deleteMediaAsset(asset.id);
      URL.revokeObjectURL(asset.url!);
    }
  });
  const importedAudio = audio as Asset | null;
  if (importedAudio?.url) URL.revokeObjectURL(importedAudio.url);
  await check("Gradient inspector switches fill modes, palettes, stops and keyframes", async () => {
    const fixture = newProject();
    fixture.texts = [makeText(0, { text: "Gradient title" })];
    const host = document.createElement("div"); document.body.appendChild(host);
    const root = createRoot(host);
    let observed = fixture;
    function Harness() {
      const [project, setProject] = useState(fixture);
      observed = project;
      return createElement(Inspector, { project, selection: { kind: "text", id: fixture.texts[0].id },
        time: 1, clear: () => {}, edit: (fn) => setProject((p) => fn(p)) });
    }
    const click = (selector: string, label: string) => {
      const button = [...host.querySelectorAll<HTMLButtonElement>(selector)]
        .find((item) => item.textContent?.trim() === label);
      assert(button, `Missing ${label} control`);
      button!.click();
    };
    try {
      root.render(createElement(Harness));
      for (let i = 0; i < 30 && !host.querySelector(".fill-mode-switch"); i++) await wait(20);
      click(".fill-mode-switch button", "Linear"); await wait(20);
      assert(observed.texts[0].fillMode === "linear", "Linear fill was not stored");
      click(".gradient-stop-heading button", "Add"); await wait(20);
      assert(observed.texts[0].gradientStops.length === 3, "Color stop was not added");
      click(".gradient-presets button", "Sunset"); await wait(20);
      assert(observed.texts[0].gradientStops[1].color === "#f06aa6", "Palette was not applied");
      const hex = host.querySelector<HTMLInputElement>('[aria-label="Stop 1 hex color"]')!;
      hex.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(hex, "#34A7CF");
      hex.dispatchEvent(new Event("input", { bubbles: true }));
      await wait(20); hex.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); await wait(20);
      assert(observed.texts[0].gradientStops[0].color === "#34a7cf", `Exact hex edit was not stored: ${observed.texts[0].gradientStops[0].color} / ${hex.value}`);
      const position = host.querySelector<HTMLInputElement>('.gradient-stop-row:nth-child(2) input[type="number"]')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(position, "63");
      position.dispatchEvent(new Event("input", { bubbles: true })); await wait(20);
      assert(Math.abs(observed.texts[0].gradientStops[1].position - 0.63) < 0.001, "Color stop position was not stored");
      const keyframe = host.querySelector<HTMLButtonElement>('[aria-label="Add gradientAngle keyframe"]');
      assert(keyframe, "Gradient angle has no keyframe diamond");
      keyframe!.click(); await wait(20);
      assert(observed.texts[0].propertyKeyframes?.gradientAngle?.length === 1, "Gradient angle keyframe was not stored");
      click(".fill-mode-switch button", "Radial"); await wait(20);
      assert(observed.texts[0].fillMode === "radial", "Radial fill was not stored");
      assert(host.querySelector<HTMLInputElement>('[aria-label="Radius"]'), "Radial radius control is missing");
      assert(host.querySelector<HTMLInputElement>('[aria-label="Stop 1 hex color"]'), "Hex color entry is missing");
    } finally {
      root.unmount(); host.remove();
    }
  });
  await check("Source cropping removes real pixels, updates hit bounds and matches export rendering", async () => {
    const source = testCanvas(); source.width = 200; source.height = 100;
    const context = source.getContext("2d")!; context.fillStyle = "#ff0000"; context.fillRect(0, 0, 100, 100); context.fillStyle = "#0000ff"; context.fillRect(100, 0, 100, 100);
    const image = new Image(); image.src = source.toDataURL(); await image.decode();
    const asset: Asset = { id: "crop-pattern", name: "Crop.png", kind: "image", duration: 5, url: image.src, width: 200, height: 100, sizeLabel: "test", theme: "image" };
    const project = newProject(); project.assets = [asset];
    const clip = { ...makeClip(asset), crop: { x: 0.5, y: 0, width: 0.5, height: 1 } };
    project.clips = [clip];
    const canvas = testCanvas(); canvas.width = 320; canvas.height = 180;
    const renderer = new Renderer(), sources = new Map([[clip.id, image]]);
    renderer.draw(canvas, project, 1, sources);
    const pixel = canvas.getContext("2d")!.getImageData(160, 90, 1, 1).data;
    assert(pixel[2] > 240 && pixel[0] < 10, "Discarded red pixels are still in cropped output");
    assert(Math.abs(renderer.bounds[0].width - 180) < 0.001 && Math.abs(renderer.bounds[0].height - 180) < 0.001, "Cropped square hit bounds are incorrect");
    const before = hash(canvas);
    const exported = testCanvas(); exported.width = 320; exported.height = 180;
    new Renderer().draw(exported, project, 1, sources);
    assert(hash(exported) === before, "Crop preview/export differ");
    renderer.draw(canvas, { ...project, clips: [{ ...clip, crop: { ...FULL_CROP } }] }, 1, sources);
    assert(hash(canvas) !== before, "Reset crop did not restore the full source");
  });
  await check("Crop dialog applies presets and exact values, cancels drafts and resets source crops", async () => {
    const image = testCanvas(); image.width = 200; image.height = 100;
    const asset: Asset = { id: "crop-ui", name: "Crop.png", kind: "image", duration: 5, url: image.toDataURL(), width: 200, height: 100, sizeLabel: "test", theme: "image" };
    const fixture = newProject(); fixture.assets = [asset]; fixture.clips = [makeClip(asset)];
    const host = document.createElement("div"); document.body.appendChild(host); const root = createRoot(host);
    let observed = fixture;
    function Harness() { const [project, setProject] = useState(fixture); observed = project;
      return createElement(Inspector, { project, selection: { kind: "clip", id: fixture.clips[0].id }, time: 1, clear: () => {}, edit: (fn) => setProject(fn) }); }
    const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((el) => el.textContent?.trim() === text)!;
    const open = async () => { button("Crop media").click(); for (let i = 0; i < 40 && (!button("Apply crop") || button("Apply crop").disabled); i++) await wait(20); assert(button("Apply crop") && !button("Apply crop").disabled, "Source did not load in crop dialog"); };
    try {
      root.render(createElement(Harness)); await wait(80); await open();
      button("1:1").click(); await wait(20);
      assert(observed.clips[0].crop?.width === 1, "Draft changed project before Apply");
      button("Apply crop").click(); await wait(40);
      assert(observed.clips[0].crop?.width === 0.5 && observed.clips[0].crop?.x === 0.25 && observed.clips[0].fit === "contain", "Square crop was not committed correctly");
      await open();
      const stage = host.querySelector<HTMLDivElement>(".crop-source-stage")!;
      stage.setPointerCapture = () => {};
      const rect = stage.getBoundingClientRect();
      const box = host.querySelector<HTMLDivElement>(".source-crop-box")!;
      box.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
      stage.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: rect.left + rect.width * 0.6, clientY: rect.top + rect.height / 2 }));
      stage.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 })); await wait(20);
      assert(Math.abs(Number(host.querySelector<HTMLInputElement>('[aria-label="Crop x (%)"]')!.value) - 35) < 0.1, "Dragging did not reposition source crop");
      host.querySelector<HTMLButtonElement>(".crop-handle.nw")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 2, clientX: 100, clientY: 100 }));
      stage.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 2, clientX: 100 + rect.width * 0.1, clientY: 100 + rect.height * 0.1 }));
      stage.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 2 })); await wait(20);
      assert(Math.abs(Number(host.querySelector<HTMLInputElement>('[aria-label="Crop width (%)"]')!.value) - 40) < 0.1, "Corner drag did not resize source crop");
      const input = host.querySelector<HTMLInputElement>('[aria-label="Crop width (%)"]')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "30"); input.dispatchEvent(new Event("input", { bubbles: true })); await wait(20);
      button("Cancel").click(); await wait(30);
      assert(observed.clips[0].crop?.width === 0.5, "Cancel committed draft crop");
      await open();
      const exact = host.querySelector<HTMLInputElement>('[aria-label="Crop width (%)"]')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(exact, "30"); exact.dispatchEvent(new Event("input", { bubbles: true })); await wait(20);
      button("Apply crop").click(); await wait(30);
      assert(observed.clips[0].crop?.width === 0.3, "Exact numeric crop was not committed");
      await open(); button("Reset").click(); await wait(20); button("Apply crop").click(); await wait(30);
      assert(observed.clips[0].crop?.width === 1 && observed.clips[0].crop?.x === 0, "Crop reset did not restore source");
      await open(); button("9:16").click(); await wait(20); button("16:9").click(); await wait(20);
      assert(Number(host.querySelector<HTMLInputElement>('[aria-label="Crop width (%)"]')!.value) > 80, "Switching crop presets repeatedly shrank the selection");
      button("Cancel").click();
    } finally { root.unmount(); host.remove(); }
  });
  await check("Preview center magnets snap media/text, toggle off, bypass with Alt and undo cleanly", async () => {
    const image = testCanvas(); image.width = 200; image.height = 100;
    image.getContext("2d")!.fillRect(0, 0, 200, 100);
    const asset: Asset = { id: "snap-image", name: "Snap.png", kind: "image", url: image.toDataURL(), duration: 5, width: 200, height: 100, sizeLabel: "test", theme: "image" };
    const fixture = newProject(); fixture.assets = [asset];
    fixture.clips = [{ ...makeClip(asset), x: 0.21, y: 0.15, scale: 0.3, rotation: 30 }];
    const host = document.createElement("div"); document.body.appendChild(host);
    const root = createRoot(host);
    let observed = fixture;
    let action: (value: Parameters<typeof historyReducer>[1]) => void = () => {};
    let selectItem: (value: { kind: "clip" | "text"; id: string }) => void = () => {};
    function Harness() {
      const [history, dispatch] = useReducer(historyReducer, { project: fixture, past: [], future: [], origin: null, group: "", at: 0 });
      const [selection, select] = useState<{ kind: "clip" | "text"; id: string } | null>({ kind: "clip", id: fixture.clips[0].id });
      observed = history.project; action = dispatch; selectItem = select;
      return createElement("div", {},
        createElement(Preview, { project: history.project, selection, select, time: 1, setTime: () => {}, seek: () => {}, playing: false, setPlaying: () => {}, dispatch, onError: (message) => { throw new Error(message); } }),
        createElement(Inspector, { project: history.project, selection, time: 1, clear: () => {}, edit: (fn) => dispatch({ type: "edit", fn, group: "", at: Date.now() }) }));
    }
    try {
      root.render(createElement(Harness));
      for (let i = 0; i < 80 && !host.querySelector(".selection-box"); i++) await wait(20);
      const canvas = host.querySelector<HTMLCanvasElement>(".preview-panel canvas")!;
      assert(canvas && host.querySelector(".selection-box"), "Preview did not render media selection");
      canvas.style.width = "800px"; canvas.style.height = "450px";
      // Synthetic pointer events exercise the real handlers; there is no native
      // active pointer for capture in this hidden test window.
      canvas.setPointerCapture = () => {};
      const send = (type: string, x: number, y: number, altKey = false) => canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 71, button: 0, buttons: type === "pointerup" ? 0 : 1, clientX: x, clientY: y, altKey }));
      const drag = async (targetX: number, targetY: number, altKey = false) => {
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        const rect = canvas.getBoundingClientRect();
        const box = host.querySelector<HTMLElement>(".selection-box")!;
        const startX = rect.left + parseFloat(box.style.left) / 100 * rect.width;
        const startY = rect.top + parseFloat(box.style.top) / 100 * rect.height;
        send("pointerdown", startX, startY); await wait(20);
        send("pointermove", rect.left + targetX * rect.width, rect.top + targetY * rect.height, altKey); await wait(80);
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      };
      const finish = () => send("pointerup", 0, 0);
      const toggle = [...host.querySelectorAll<HTMLLabelElement>(".toggle-field")].find((label) => label.textContent?.includes("Snap to center guides"))!.querySelector<HTMLInputElement>("input")!;
      assert(toggle.checked, "Media snapping is not on by default");
      await drag(0.506, 0.508);
      assert(Math.abs(observed.clips[0].x) < 1e-9 && Math.abs(observed.clips[0].y) < 1e-9, "Media did not snap exactly to center");
      assert(host.querySelector(".alignment-snap-guides i") && host.querySelector(".alignment-snap-guides b"), "Center guides are missing");
      finish(); await wait(30);
      assert(!host.querySelector(".alignment-snap-guides"), "Guides remained after releasing drag");
      action({ type: "undo" }); await wait(60);
      assert(observed.clips[0].x === 0.21, "Drag did not undo in one step");
      toggle.click(); await wait(30);
      await drag(0.506, 0.508);
      assert(Math.abs(observed.clips[0].x - 0.006) < 1e-6, "Disabled snapping still moved media to center");
      assert(!host.querySelector(".alignment-snap-guides"), "Disabled snapping showed guides");
      finish(); await wait(30); toggle.click(); await wait(30);
      await drag(0.509, 0.508, true);
      assert(Math.abs(observed.clips[0].x - 0.009) < 1e-6, `Alt did not bypass center snapping: x=${observed.clips[0].x}, enabled=${observed.clips[0].snapToGuides}, guides=${Boolean(host.querySelector('.alignment-snap-guides'))}`);
      send("pointercancel", 0, 0); await wait(60);
      assert(Math.abs(observed.clips[0].x - 0.006) < 1e-6, "Cancelled drag did not restore original position");
      const text = makeText(0, { text: "Left aligned", align: "left", x: 0.2, y: 0.3, rotation: 35 });
      action({ type: "load", project: { ...fixture, clips: [], texts: [text] } }); selectItem({ kind: "text", id: text.id }); await wait(80);
      await drag(0.506, 0.508);
      const bounds = host.querySelector<HTMLElement>(".selection-box")!;
      assert(Math.abs(parseFloat(bounds.style.left) - 50) < 0.001 && Math.abs(parseFloat(bounds.style.top) - 50) < 0.001, "Rotated left-aligned text bounds did not snap to center");
      finish();
    } finally { root.unmount(); host.remove(); }
  });
  await check("Animation inspector saves a tuned text exit and reapplies it to video", async () => {
    localStorage.removeItem("cutline:custom-animation-presets:v1");
    const fixture = newProject();
    fixture.assets = [SAMPLE_ASSETS[0]];
    fixture.clips = [makeClip(SAMPLE_ASSETS[0], 0, 0)];
    fixture.texts = [makeText(0, { text: "Animate me", track: 1 })];
    const host = document.createElement("div"); document.body.appendChild(host);
    const root = createRoot(host);
    let observed = fixture;
    let selectItem: (value: { kind: "clip" | "text"; id: string }) => void = () => {};
    function Harness() {
      const [project, setProject] = useState(fixture);
      const [selection, setSelection] = useState<{ kind: "clip" | "text"; id: string }>({ kind: "text", id: fixture.texts[0].id });
      observed = project;
      selectItem = setSelection;
      return createElement(Inspector, { project, selection, time: 3.8, clear: () => {}, edit: (fn) => setProject((p) => fn(p)) });
    }
    try {
      root.render(createElement(Harness));
      for (let i = 0; i < 30 && !host.querySelector(".inspector-tabs"); i++) await wait(20);
      const clickText = (selector: string, label: string) => {
        const button = [...host.querySelectorAll<HTMLButtonElement>(selector)].find((el) => el.textContent?.trim() === label);
        assert(button, `Missing ${label} button`); button!.click();
      };
      clickText(".inspector-tabs button", "Animation"); await wait(20);
      clickText(".animation-phase button", "Combo"); await wait(20);
      host.querySelector<HTMLButtonElement>('[aria-label="Combo Wave"]')!.click(); await wait(20);
      host.querySelector<HTMLButtonElement>('[aria-label="Combo Pulse"]')!.click(); await wait(20);
      assert(observed.texts[0].comboAnimations?.map((layer) => layer.name).join(",") === "Wave,Pulse", "Text combos did not stack on the selected layer");
      selectItem({ kind: "clip", id: fixture.clips[0].id }); await wait(20);
      host.querySelector<HTMLButtonElement>('[aria-label="Combo Zoom"]')!.click(); await wait(20);
      assert(observed.clips[0].comboAnimations?.[0].name === "Zoom", "Combo animations did not apply to video clips");
      selectItem({ kind: "text", id: fixture.texts[0].id }); await wait(20);
      clickText(".animation-phase button", "Exit"); await wait(20);
      host.querySelector<HTMLButtonElement>('[aria-label="Exit Zoom"]')!.click(); await wait(20);
      clickText(".animation-zoom-choice button", "Zoom out"); await wait(20);
      assert(observed.texts[0].exitAnimationSettings?.zoomDirection === "out", "Zoom direction did not update the text clip");
      host.querySelector<HTMLButtonElement>('[aria-label="Exit Drift"]')!.click(); await wait(20);
      host.querySelector<HTMLButtonElement>('[aria-label="Move left"]')!.click(); await wait(20);
      assert(observed.texts[0].exitAnimationStack?.length === 2, "Second exit animation did not stack");
      assert(observed.texts[0].exitAnimationStack?.[1].settings.angle === 180, "Drift direction was not tuned independently");
      const input = host.querySelector<HTMLInputElement>('[aria-label="New animation preset name"]')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Shrink away");
      input.dispatchEvent(new Event("input", { bubbles: true })); await wait(20);
      clickText(".animation-save-row button", "Save"); await wait(20);
      assert(JSON.parse(localStorage.getItem("cutline:custom-animation-presets:v1") || "[]").length === 1, "Custom animation was not saved");
      selectItem({ kind: "clip", id: fixture.clips[0].id }); await wait(20);
      clickText(".custom-animation-apply", "Shrink awayZoom + Drift · 0.5s"); await wait(20);
      assert(observed.clips[0].exitAnimation === "Zoom", "Saved preset did not apply to video");
      assert(observed.clips[0].exitAnimationSettings?.zoomDirection === "out", "Saved zoom direction was lost");
      assert(observed.clips[0].exitAnimationStack?.length === 2, "Saved stack did not apply to video");
      host.querySelector<HTMLButtonElement>('[aria-label="Exit Fade"]')!.click(); await wait(20);
      assert(observed.clips[0].exitAnimationStack?.length === 3, "Video did not accept a third stacked animation");
      host.querySelector<HTMLButtonElement>('[aria-label="Exit Fade"]')!.click(); await wait(20);
      assert(observed.clips[0].exitAnimationStack?.length === 2, "Clicking a selected animation did not remove it");
    } finally {
      root.unmount(); host.remove();
      localStorage.removeItem("cutline:custom-animation-presets:v1");
    }
  });
  await check("Editor drag-and-drop transition attaches to a real clip join", async () => {
    const fixture = newProject();
    const image = document.createElement("canvas");
    image.width = image.height = 32;
    image.getContext("2d")!.fillRect(0, 0, 32, 32);
    const blob = await new Promise<Blob>((resolve) => image.toBlob((value) => resolve(value!), "image/png"));
    const asset = { id: "transition-image", name: "Transition image", kind: "image" as const, duration: 5, theme: "image", sizeLabel: "32px" };
    await saveMediaAsset({ ...asset, blob });
    fixture.assets = [asset];
    fixture.clips = [
      { ...makeClip(asset, 0, 1), sourceEnd: 1.5 },
      { ...makeClip(asset, 1.5, 1), sourceEnd: 2.5 },
    ];
    await saveProject(persistable(fixture));
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      root.render(createElement(Editor));
      for (let i = 0; i < 50 && !host.querySelector(".transition-join"); i++) await wait(20);
      const join = host.querySelector<HTMLElement>(".transition-join");
      assert(join, "The join between adjacent clips is not visible");
      const nav = [...host.querySelectorAll<HTMLButtonElement>(".library-nav button")]
        .find((button) => button.textContent?.includes("Transitions"));
      assert(nav, "Transitions library is missing");
      nav!.click();
      await wait(50);
      const card = [...host.querySelectorAll<HTMLElement>(".transition-card")]
        .find((button) => button.textContent?.includes("Dissolve"));
      assert(card?.draggable, "Transition cards must be draggable");
      const data = new DataTransfer();
      card!.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: data }));
      assert(data.getData("application/cutline-transition") === "Dissolve", "Drag did not carry the transition preset");
      join!.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: data }));
      join!.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }));
      await wait(100);
      assert(host.querySelector(".transition-join.applied"), "Drop did not apply transition to join");
      assert(host.querySelector(".transition-span"), "Join has no centered transition span");
    } finally {
      root.unmount();
      host.remove();
    }
  });
  await check("Imported audio appears in Media and adds a real waveform clip", async () => {
    await saveProject(persistable(newProject()));
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      root.render(createElement(Editor));
      for (let i = 0; i < 80 && !host.querySelector('[aria-label="Play"]:not([disabled])'); i++) await wait(20);
      const input = host.querySelector<HTMLInputElement>('input[type="file"][accept^="video/"]');
      assert(input, "Media import input is missing");
      const transfer = new DataTransfer();
      transfer.items.add(wav);
      input!.files = transfer.files;
      input!.dispatchEvent(new Event("change", { bubbles: true }));
      for (let i = 0; i < 150 && !host.querySelector('[aria-label="Add test-tone.wav to timeline"]'); i++) await wait(20);
      const card = host.querySelector<HTMLButtonElement>('[aria-label="Add test-tone.wav to timeline"]');
      assert(card, "Imported audio is hidden from the Media tab");
      card!.click();
      for (let i = 0; i < 50 && !host.querySelector(".clip-audio .waveform-body[d]"); i++) await wait(20);
      const waveform = host.querySelector<SVGPathElement>(".clip-audio .waveform-body");
      assert((waveform?.getAttribute("d") ?? "").includes("M"), "Audio clip has no decoded waveform on the timeline");
      const audioTab = [...host.querySelectorAll<HTMLButtonElement>(".library-nav button")].find((button) => button.textContent?.includes("Audio"));
      assert(audioTab, "Audio library is missing");
      audioTab!.click();
      await wait(30);
      assert(host.querySelector('[aria-label="Add test-tone.wav to timeline"]'), "Audio library lost the imported file");
    } finally {
      root.unmount(); host.remove();
    }
  });
  await check("Existing audio projects upgrade coarse waveforms without reimporting", async () => {
    const legacyAudio = { ...audio!, id: "legacy-waveform", kind: "audio" as const, waveform: Array(320).fill(0.25), waveformPeaks: undefined };
    const fixture = newProject();
    fixture.assets = [legacyAudio];
    fixture.clips = [makeClip(legacyAudio)];
    await saveMediaAsset({ ...legacyAudio, blob: wav });
    await saveProject(persistable(fixture));
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      root.render(createElement(Editor));
      let upgraded = false;
      for (let i = 0; i < 100 && !upgraded; i++) {
        await wait(30);
        const stored = await loadProject();
        const asset = stored.project?.assets.find((item) => item.id === legacyAudio.id);
        upgraded = (asset?.waveformPeaks?.length ?? 0) >= 1024;
      }
      assert(upgraded, "Saved audio did not receive a higher-resolution envelope");
    } finally {
      root.unmount(); host.remove();
    }
  });
  await check("Editor seeks beyond the last clip, stays there, and previews empty space", async () => {
    const fixture = newProject();
    fixture.texts = [makeText(0, { duration: 1, text: "Timeline fixture" })];
    await saveProject(persistable(fixture));
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      root.render(createElement(Editor));
      for (let i = 0; i < 50 && !host.querySelector('[aria-label="Play"]:not([disabled])'); i++)
        await wait(20);
      assert(host.querySelector('[aria-label="Play"]:not([disabled])'), "Fixture did not load");
      const playhead = () => Number(host.querySelector('[aria-label="Playhead"]')?.getAttribute("aria-valuenow"));
      host.querySelector<HTMLButtonElement>('[aria-label="Go to end"]')!.click();
      await wait(50);
      assert(playhead() === 1, "Go to end must still target actual media duration");
      host.querySelector<HTMLButtonElement>('[aria-label="Next frame"]')!.click();
      await wait(100);
      assert(playhead() > 1, "Next frame was clamped to the last clip");
      const at = playhead();
      host.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      await wait(100);
      assert(playhead() > at, "Keyboard seeking was clamped to the last clip");
      const canvas = host.querySelector("canvas")!;
      let pixels = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let i = 0; i < 30 && !(pixels[0] === 8 && pixels[1] === 11 && pixels[2] === 17); i++) {
        await wait(20);
        pixels = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
      }
      for (let i = 0; i < pixels.length; i += 4)
        assert(pixels[i] === 8 && pixels[i + 1] === 11 && pixels[i + 2] === 17,
          `Empty space must not freeze the last clip's frame (pixel ${[...pixels.slice(0, 4)]}, time ${playhead()})`);
      assert(host.querySelector(".timecode")?.textContent?.includes("/ 00:01:00"),
        "Seeking changed media/export duration");
    } finally {
      root.unmount();
      host.remove();
    }
  });
  await check("Codex edits the live Editor atomically, previews frames, rejects stale/cancelled tools and undoes/redoes", async () => {
    const fixture = newProject();
    await saveProject(persistable(fixture));
    let onEvent: ((event: CodexEvent) => void) | undefined;
    let onTool: ((request: CodexToolRequest) => Promise<CodexToolResult>) | undefined;
    const state: CodexStatus = { connected: false, needsLogin: false, busy: false, models: [{ id: "test", name: "Test", isDefault: true }] };
    let toolActive = true;
    window.cutlineDesktop = {
      isDesktop: true, platform: "win32", version: async () => "0.4.0",
      isMaximized: async () => false, isFullscreen: async () => false,
      onMaximizedChange: () => () => {}, onFullscreenChange: () => () => {},
      minimize: () => {}, maximize: () => {}, close: () => {}, toggleFullscreen: () => {},
      listInstalledFonts: async () => ["Test Installed Font"], saveFile: async () => ({ canceled: true }),
      confirmNewProject: async () => true, onBeforeClose: () => () => {},
      codexStatus: async () => state,
      codexConnect: async () => { state.connected = true; onEvent?.({ type: "status", ...state }); return state; },
      codexLogin: async () => {}, codexSend: async () => ({ threadId: "test" }), codexStop: async () => {}, codexReset: async () => {}, codexDisconnect: async () => {},
      codexToolActive: async () => toolActive,
      onCodexEvent: (callback) => { onEvent = callback; return () => { onEvent = undefined; }; },
      onCodexTool: (callback) => { onTool = callback; return () => { onTool = undefined; }; },
    };
    const host = document.createElement("div"); document.body.appendChild(host);
    const root = createRoot(host);
    const call = (name: string, args: unknown) => onTool!({ id: "test-call", projectId: fixture.id, name: "cutline_" + name, args });
    const snapshot = async () => {
      const item = (await call("get_project", {})).contentItems[0];
      return JSON.parse(item.type === "inputText" ? item.text : "{}");
    };
    try {
      root.render(createElement(Editor));
      for (let i = 0; i < 80 && (!onTool || !host.querySelector('[aria-label="Play"]:not([disabled])')); i++) await wait(20);
      assert(onTool, "Editor did not subscribe to Codex tools");
      host.querySelector<HTMLButtonElement>(".codex-toggle")!.click(); await wait(30);
      assert(host.querySelector('[aria-label="Codex video assistant"]'), "Codex panel missing");
      host.querySelector<HTMLButtonElement>(".codex-connect")!.click(); await wait(30);
      assert(host.querySelector('[aria-label="Describe your video edit"]'), "Chat did not open after connect");
      const catalog = await call("get_catalog", {});
      assert(JSON.stringify(catalog).includes("Test Installed Font"), "Installed fonts not available to AI");
      const before = await snapshot();
      const request = { projectId: fixture.id, expectedRevision: before.revision, operations: [
        { op: "add_text", ref: "title", text: "Codex live edit", start: 0, duration: 4, track: 2, patch: { fontSize: 100, color: "#f08020" } },
        { op: "animation", id: "@title", phase: "Entrance", duration: 0.5, layers: [{ name: "Letter Pop In" }] },
        { op: "effect", id: "@title", name: "Wavy", amount: 20, waves: 6 },
      ] };
      const applied = await call("apply_edits", request);
      assert(applied.success, "Edit failed");
      const after = await snapshot();
      assert(after.texts.length === 1 && after.texts[0].text === "Codex live edit", "Live timeline did not update");
      assert(after.texts[0].effects[0].waves === 6 && after.texts[0].animationStack[0].name === "Letter Pop In", "Batch did not apply effects/animation");
      let staleRejected = false;
      try { await call("apply_edits", request); } catch { staleRejected = true; }
      assert(staleRejected, "Stale edit overwrote project");
      const preview = await call("preview", { time: 1 });
      await wait(30);
      assert(preview.contentItems.some((item) => item.type === "inputImage" && item.imageUrl.startsWith("data:image/jpeg")), "AI did not receive rendered preview");
      assert(Number(host.querySelector('[aria-label="Playhead"]')?.getAttribute("aria-valuenow")) === 1, "Preview did not seek live player");
      await call("history", { action: "undo" });
      assert((await snapshot()).texts.length === 0, "Batch was not undone in one step");
      await call("history", { action: "redo" });
      assert((await snapshot()).texts.length === 1, "Batch could not be redone");
      await wait(250);
      assert(((await loadProject()).project?.texts as { text: string }[])?.[0]?.text === "Codex live edit", "AI edits were not autosaved");
      toolActive = false;
      let cancelled = false; try { await call("history", { action: "undo" }); } catch { cancelled = true; }
      assert(cancelled && (await loadProject()).project?.texts.length === 1, "Cancelled request modified timeline");
    } finally { root.unmount(); host.remove(); delete window.cutlineDesktop; }
  });
  await runVisualCompositingTests(check, assert);
  await runMaskUiChecks(check);
  await runColorGradingChecks(check);
  await runTextFontChecks(check);
  await runAudioReliabilityChecks(check);
  await runExpandedEffectsTests(check, assert);
  await runTransitionTests(check, assert);
  await runSceneDetectionChecks(check, assert);
  return { passed, failures, details };
}
(
  globalThis as typeof globalThis & { runEngineTests: typeof runEngineTests }
).runEngineTests = runEngineTests;

async function runSceneTests() {
  const passed: string[] = [], failures: string[] = [];
  await runSceneDetectionChecks(async (name, run) => {
    try { await run(); passed.push(name); } catch (error) { failures.push(`${name}: ${String((error as Error).stack ?? error)}`); }
  }, assert);
  return { passed, failures };
}
(globalThis as typeof globalThis & { runSceneTests: typeof runSceneTests }).runSceneTests = runSceneTests;
