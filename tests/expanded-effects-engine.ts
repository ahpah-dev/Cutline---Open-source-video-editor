import { makeClip, makeText, newProject, setPropertyKeyframe, type Asset } from "../app/editor/model";
import { Renderer } from "../app/editor/renderer";
import { EFFECTS } from "../app/editor/presets";
import { applyExpandedEffect, EXPANDED_EFFECTS } from "../app/editor/expandedEffects";

type Check = (name: string, run: () => unknown) => Promise<void>;
type Assert = (condition: unknown, message: string) => void;
const canvas = (width = 320, height = 180) => { const c = document.createElement("canvas"); c.width = width; c.height = height; return c; };
const hash = (c: HTMLCanvasElement) => {
  const data = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
  let n = 2166136261; for (const value of data) n = Math.imul(n ^ value, 16777619); return n >>> 0;
};
const pixel = (c: HTMLCanvasElement, x: number, y: number) => [...c.getContext("2d")!.getImageData(x, y, 1, 1).data];
const fixture = async () => {
  const source = canvas(), ctx = source.getContext("2d")!;
  const gradient = ctx.createLinearGradient(0, 0, 320, 180);
  gradient.addColorStop(0, "#26396f"); gradient.addColorStop(.4, "#ebb57a"); gradient.addColorStop(1, "#77ad91");
  ctx.fillStyle = gradient; ctx.fillRect(0, 0, 320, 180);
  ctx.fillStyle = "#bd408c"; ctx.fillRect(23, 22, 91, 62);
  ctx.fillStyle = "#eee8d9"; ctx.beginPath(); ctx.arc(211, 100, 33, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = "#181b25"; ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(0, 145); ctx.lineTo(283, 26); ctx.stroke();
  const image = new Image(); image.src = source.toDataURL(); await image.decode();
  const asset: Asset = { id: "effect-source", name: "effect-source.png", kind: "image", width: 320, height: 180, duration: 5, theme: "image", sizeLabel: "1 KB" };
  const clip = makeClip(asset), project = newProject(); project.assets = [asset]; project.clips = [clip]; project.background = "#1b2234";
  return { project, clip, sources: new Map([[clip.id, image]]) };
};

export async function runExpandedEffectsTests(check: Check, assert: Assert) {
  await check("Expanded effect catalog contains 34 real editable presets with useful defaults", () => {
    assert(EFFECTS.length >= 34 && EXPANDED_EFFECTS.length === 21, "Expected 21 new effects and 34 total");
    assert(new Set(EFFECTS.map((effect) => effect.name)).size === EFFECTS.length, "Duplicate effect names");
    assert(EFFECTS.every((effect) => effect.category && effect.description.length > 10 && effect.defaultAmount > 0 && effect.defaultAmount <= 100), "Missing effect metadata/default");
  });
  await check("All new effects visibly render distinct pixels and reproduce exactly at a fixed time", async () => {
    const f = await fixture(), output = canvas(), repeated = canvas(), renderer = new Renderer();
    renderer.draw(output, f.project, .37, f.sources); const baseline = hash(output), results = new Set<number>();
    for (const name of EXPANDED_EFFECTS) {
      f.project.clips[0] = { ...f.clip, effects: [{ name, amount: 80 }] };
      renderer.draw(output, f.project, .37, f.sources);
      const result = hash(output); assert(result !== baseline, name + " did not modify real image pixels"); results.add(result);
      const exportRenderer = new Renderer(); exportRenderer.draw(repeated, f.project, .37, f.sources); exportRenderer.dispose();
      assert(hash(repeated) === result, name + " preview/export frame is not deterministic");
    }
    assert(results.size === EXPANDED_EFFECTS.length, "New effects should not alias the same rendered appearance");
    renderer.dispose();
  });
  await check("Zero effect amount is exact identity for every image and text effect", async () => {
    const f = await fixture(), output = canvas(), renderer = new Renderer();
    renderer.draw(output, f.project, .37, f.sources); const imageBaseline = hash(output);
    for (const { name } of EFFECTS) {
      f.project.clips[0] = { ...f.clip, effects: [{ name, amount: 0 }] };
      renderer.draw(output, f.project, .37, f.sources); assert(hash(output) === imageBaseline, name + " at zero modified image");
    }
    f.project.clips = []; const text = makeText(0, { text: "CUTLINE", fontSize: 135, color: "#efbc85", shadowBlur: 0, shadowOffset: 0, strokeWidth: 0 });
    f.project.texts = [text]; renderer.draw(output, f.project, .37, f.sources); const textBaseline = hash(output);
    for (const { name } of EFFECTS) {
      f.project.texts[0] = { ...text, effects: [{ name, amount: 0 }] };
      renderer.draw(output, f.project, .37, f.sources); assert(hash(output) === textBaseline, name + " at zero modified text");
    }
    renderer.dispose();
  });
  await check("Every new effect supports transparent text without painting the frame background", () => {
    const project = newProject(); project.background = "#1b2234";
    const text = makeText(0, { text: "CUTLINE", fontSize: 140, x: .53, y: .38, color: "#ebb683", shadowBlur: 0, shadowOffset: 0, strokeWidth: 0 });
    project.texts = [text]; const output = canvas(), renderer = new Renderer();
    renderer.draw(output, project, .37, new Map()); const baseline = hash(output), corner = pixel(output, 1, 1);
    for (const name of EXPANDED_EFFECTS) {
      project.texts[0] = { ...text, effects: [{ name, amount: 80 }] };
      renderer.draw(output, project, .37, new Map());
      assert(hash(output) !== baseline, name + " has no visible effect on text");
      assert(pixel(output, 1, 1).every((value, i) => value === corner[i]), name + " painted behind transparent text");
    }
    renderer.dispose();
  });
  await check("Animated effects and intensity keyframes change the same shared rendered output", async () => {
    const f = await fixture(), output = canvas(), renderer = new Renderer();
    for (const name of ["Light leak", "Film dust", "Film scratches", "Flicker", "Strobe", "Ripple"] as const) {
      f.project.clips[0] = { ...f.clip, effects: [{ name, amount: 80 }] };
      renderer.draw(output, f.project, .1, f.sources); const first = hash(output);
      renderer.draw(output, f.project, .2, f.sources); assert(hash(output) !== first, name + " does not animate");
    }
    let animated = { ...f.clip, effects: [{ name: "Negative" as const, amount: 0 }] };
    animated = setPropertyKeyframe(animated, "effect:Negative", 0, 0); animated = setPropertyKeyframe(animated, "effect:Negative", 2, 100);
    f.project.clips[0] = animated;
    renderer.draw(output, f.project, 0, f.sources); const start = hash(output);
    renderer.draw(output, f.project, 1, f.sources); const middle = hash(output);
    renderer.draw(output, f.project, 2, f.sources); assert(hash(output) !== middle && middle !== start, "Effect amount keyframes were ignored");
    renderer.dispose();
  });
  await check("Pixel-heavy effects bound intermediate allocation and preserve source transparency", () => {
    const source = canvas(1920, 1080), output = canvas(1920, 1080), scratch = canvas();
    const src = source.getContext("2d")!; src.fillStyle = "rgba(230,90,60,.5)"; src.fillRect(700, 400, 400, 200);
    const ctx = output.getContext("2d")!;
    for (const name of ["Posterize", "Negative", "Solarize", "Halftone", "Edge glow", "Sketch", "Fisheye", "Swirl", "Ripple", "Kaleidoscope", "Mirror"] as const) {
      ctx.clearRect(0, 0, 1920, 1080); ctx.drawImage(source, 0, 0);
      applyExpandedEffect(ctx, source, scratch, 1920, 1080, name, .8, .37, { x: 0, y: 0, width: 1920, height: 1080 });
      assert(Math.max(scratch.width, scratch.height) <= 1024, name + " allocated an unbounded full-resolution pixel buffer");
      assert(pixel(output, 0, 0)[3] === 0, name + " replaced transparent pixels with opaque black");
    }
  });
  await check("Reordering Blur and Posterize changes both image and text pixels", async () => {
    const f = await fixture(), output = canvas(), renderer = new Renderer();
    const ordered = [{ name: "Blur" as const, amount: 65 }, { name: "Posterize" as const, amount: 85 }];
    f.project.clips[0] = { ...f.clip, effects: ordered };
    renderer.draw(output, f.project, .37, f.sources); const first = hash(output);
    f.project.clips[0].effects = [...ordered].reverse(); renderer.draw(output, f.project, .37, f.sources);
    assert(hash(output) !== first, "Image Blur is still outside the ordered effect stack");
    f.project.clips = []; f.project.texts = [makeText(0, { text: "ORDER", color: "#d6a284", fontSize: 180, shadowBlur: 0, shadowOffset: 0, effects: ordered })];
    renderer.draw(output, f.project, .37, f.sources); const textFirst = hash(output);
    f.project.texts[0].effects = [...ordered].reverse(); renderer.draw(output, f.project, .37, f.sources);
    assert(hash(output) !== textFirst, "Text Blur is still outside the ordered effect stack");
    renderer.dispose();
  });
  await check("Prism and Duotone retain transparent PNG corners and partial alpha", async () => {
    const source = canvas(), ctx = source.getContext("2d")!;
    ctx.fillStyle = "rgba(190,85,60,.5)"; ctx.fillRect(100, 45, 120, 90);
    const image = new Image(); image.src = source.toDataURL(); await image.decode();
    const asset: Asset = { id: "transparent-png", name: "transparent.png", kind: "image", duration: 4, width: 320, height: 180, theme: "image", sizeLabel: "1 KB" };
    const clip = makeClip(asset), project = newProject(); project.assets = [asset]; project.clips = [clip]; project.background = "transparent";
    const sources = new Map([[clip.id, image]]), output = canvas(), renderer = new Renderer();
    renderer.draw(output, project, .37, sources); const baseline = pixel(output, 160, 90);
    for (const name of ["Prism", "Duotone"] as const) {
      project.clips[0] = { ...clip, effects: [{ name, amount: 85 }] };
      renderer.draw(output, project, .37, sources);
      assert(pixel(output, 0, 0)[3] === 0, name + " painted a rectangle behind a transparent PNG");
      const center = pixel(output, 160, 90);
      assert(center[3] === baseline[3], name + " altered the PNG's partial source alpha");
      assert(center.some((value, index) => index < 3 && value !== baseline[index]), name + " failed to tint actual source pixels");
    }
    renderer.dispose();
  });
}
