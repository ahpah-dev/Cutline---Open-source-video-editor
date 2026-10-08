import { clamp, type AnimationName, type TextAnimationOptions } from "./model";

export const TEXT_SEQUENCE_ANIMATIONS = ["Letter Pop In", "Letter Fade", "Letter Slide", "Letter Blur", "Letter Spin", "Letter Bounce", "Letter Flip", "Word Pop", "Line Slide"] as const satisfies readonly AnimationName[];
export const isTextSequenceAnimation = (name: string) => name === "Typewriter" || (TEXT_SEQUENCE_ANIMATIONS as readonly string[]).includes(name);
export type TextSequenceLayer = { name: AnimationName; progress: number; exiting: boolean; settings: TextAnimationOptions };
export type TextUnit = { line: number; start: number; end: number; index: number };
const finite = (value: number | undefined, fallback: number, min: number, max: number) => typeof value === "number" && Number.isFinite(value) ? clamp(value, min, max) : fallback;

export function sequenceDefaults(name: AnimationName): TextAnimationOptions {
  return {
    unit: name === "Word Pop" ? "word" : name === "Line Slide" ? "line" : "letter",
    order: "forward", stagger: name === "Typewriter" ? 0.9 : 0.65, overshoot: 0.35,
    flipAxis: "horizontal", seed: 0,
    angle: name === "Line Slide" ? 180 : 90,
    distance: name === "Line Slide" ? 0.08 : 0.035,
    zoomAmount: name === "Word Pop" ? 0.75 : 0.86,
    rotation: name === "Letter Spin" ? -100 : 0,
    blur: name === "Letter Blur" ? 0.006 : 0,
    fade: true, easing: "ease-out",
  };
}

/** Grapheme segmentation preserves emoji/ZWJ sequences and combining accents. */
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export function segmentTextUnits(text: string, unit: TextAnimationOptions["unit"] = "letter"): TextUnit[] {
  const groups: Omit<TextUnit, "index">[] = [];
  text.split("\n").forEach((line, lineIndex) => {
    if (unit === "line") {
      if (/\S/u.test(line)) groups.push({ line: lineIndex, start: 0, end: line.length });
    } else if (unit === "word") {
      for (const match of line.matchAll(/\S+/gu)) groups.push({ line: lineIndex, start: match.index, end: match.index + match[0].length });
    } else {
      for (const item of graphemes.segment(line)) if (/\S/u.test(item.segment)) groups.push({ line: lineIndex, start: item.index, end: item.index + item.segment.length });
    }
  });
  // Keep long single-line titles affordable; adjacent units animate as small batches.
  const batch = Math.max(1, Math.ceil(groups.length / 256));
  const bounded: Omit<TextUnit, "index">[] = [];
  for (let i = 0; i < groups.length;) {
    const first = groups[i++]; let end = first.end;
    for (let n = 1; n < batch && i < groups.length && groups[i].line === first.line; n++) end = groups[i++].end;
    bounded.push({ ...first, end });
  }
  return bounded.map((group, index) => ({ ...group, index }));
}

export function sequenceRanks(count: number, order: TextAnimationOptions["order"] = "forward", seed = 0): number[] {
  const indices = Array.from({ length: count }, (_, index) => index);
  const center = (count - 1) / 2;
  const randomKey = (index: number) => { let n = Math.imul(index + 1, 0x45d9f3b) ^ Math.trunc(finite(seed, 0, 0, 9999)); n = Math.imul(n ^ n >>> 16, 0x45d9f3b); return (n ^ n >>> 16) >>> 0; };
  if (order === "reverse") indices.reverse();
  if (order === "center-out") indices.sort((a, b) => Math.abs(a - center) - Math.abs(b - center) || a - b);
  if (order === "edges-in") indices.sort((a, b) => Math.abs(b - center) - Math.abs(a - center) || a - b);
  if (order === "random") indices.sort((a, b) => randomKey(a) - randomKey(b) || a - b);
  const ranks = new Array<number>(count);
  indices.forEach((index, rank) => { ranks[index] = rank; });
  return ranks;
}

export function easeAnimation(progress: number, easing: TextAnimationOptions["easing"] = "ease-out"): number {
  const p = clamp(progress, 0, 1);
  if (p === 0 || p === 1) return p;
  if (easing === "linear") return p;
  if (easing === "ease-in") return p ** 3;
  if (easing === "ease-in-out") return p * p * (3 - 2 * p);
  if (easing === "back") return 1 + 2.70158 * (p - 1) ** 3 + 1.70158 * (p - 1) ** 2;
  if (easing === "spring") return 1 - Math.cos(p * Math.PI * 4.5) * 2 ** (-9 * p);
  return 1 - (1 - p) ** 3;
}

export function layerProgress(visibleProgress: number, exiting: boolean, settings: TextAnimationOptions): number {
  const delay = finite(settings.delay, 0, 0, 0.95);
  const span = Math.min(1 - delay, finite(settings.span, 1, 0.01, 1));
  const elapsed = exiting ? 1 - visibleProgress : visibleProgress;
  const p = clamp((elapsed - delay) / span, 0, 1);
  return exiting ? 1 - p : p;
}

export function sequenceUnitProgress(layer: TextSequenceLayer, rank: number, count: number): number {
  const stagger = finite(layer.settings.stagger, 0.65, 0, 0.95);
  const delay = count > 1 ? rank / (count - 1) * stagger : 0;
  const elapsed = layer.exiting ? 1 - layer.progress : layer.progress;
  const p = clamp((elapsed - delay) / (1 - stagger), 0, 1);
  return layer.exiting ? 1 - p : p;
}

export function sequenceUnitMotion(layer: TextSequenceLayer, rank: number, count: number) {
  const settings = layer.settings;
  const p = sequenceUnitProgress(layer, rank, count), ease = easeAnimation(p, settings.easing), hidden = 1 - ease;
  const motion = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, blur: 0, opacity: p <= 0 ? 0 : settings.fade === false ? 1 : clamp(ease, 0, 1) };
  if (p === 1) return motion;
  const angle = finite(settings.angle, 90, -360, 360) * Math.PI / 180;
  const distance = finite(settings.distance, 0.035, 0, 1);
  const overshoot = finite(settings.overshoot, 0.35, 0, 1);
  if (["Letter Slide", "Line Slide", "Letter Bounce"].includes(layer.name)) {
    const displacement = layer.name === "Letter Bounce" ? hidden + Math.sin(p * Math.PI * 3) * (1 - p) * overshoot : hidden;
    motion.x = Math.cos(angle) * distance * displacement;
    motion.y = Math.sin(angle) * distance * displacement;
  }
  if (["Letter Pop In", "Word Pop", "Letter Bounce"].includes(layer.name)) {
    const zoom = finite(settings.zoomAmount, 0.86, 0, 2);
    const smaller = layer.exiting ? settings.zoomDirection !== "in" : settings.zoomDirection !== "out";
    motion.scaleX = motion.scaleY = Math.max(0.02, 1 + (smaller ? -1 : 1) * zoom * hidden + Math.sin(p * Math.PI) * (1 - p) * overshoot);
  }
  if (layer.name === "Letter Flip") {
    const scale = Math.max(0.001, Math.cos(hidden * Math.PI / 2));
    if (settings.flipAxis === "vertical") motion.scaleY = scale; else motion.scaleX = scale;
  }
  motion.rotation = finite(settings.rotation, 0, -720, 720) * hidden;
  motion.blur = Math.max(0, finite(settings.blur, 0, 0, 0.1) * hidden);
  if (layer.name === "Typewriter") motion.opacity = p > 0 ? 1 : 0;
  return motion;
}
