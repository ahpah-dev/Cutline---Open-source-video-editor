import { FULL_CROP, normalizeCrop, type SourceCrop } from "./crop";
import { DEFAULT_COMPOSITING, normalizeCompositing, type VisualCompositing } from "./visualCompositing";
import { GRADE_DEFAULTS, identityCurves, normalizeGrade, type ColorGrading } from "./colorGrading";
export type MediaKind = "video" | "image" | "audio" | "demo";
export type Ratio = "16:9" | "9:16" | "1:1" | "4:5";
export type EffectName =
  | "Vignette"
  | "Grain"
  | "Glow"
  | "Blur"
  | "Pixelate"
  | "Chromatic"
  | "Scanlines"
  | "Duotone"
  | "Shake"
  | "Pulse"
  | "Letterbox"
  | "Prism"
  | "Wavy"
  | "Soft focus"
  | "Directional blur"
  | "Zoom blur"
  | "Radial blur"
  | "Tilt shift"
  | "Light leak"
  | "Film dust"
  | "Film scratches"
  | "Flicker"
  | "Strobe"
  | "Posterize"
  | "Negative"
  | "Solarize"
  | "Halftone"
  | "Edge glow"
  | "Sketch"
  | "Fisheye"
  | "Swirl"
  | "Ripple"
  | "Kaleidoscope"
  | "Mirror";
export type TransitionName =
  | "None"
  | "Dissolve"
  | "Fade black"
  | "Fade white"
  | "Wipe left"
  | "Wipe right"
  | "Wipe up"
  | "Wipe down"
  | "Diagonal top left"
  | "Diagonal top right"
  | "Diagonal bottom left"
  | "Diagonal bottom right"
  | "Slide left"
  | "Slide right"
  | "Slide up"
  | "Slide down"
  | "Push up left"
  | "Push up right"
  | "Zoom"
  | "Zoom out"
  | "Cross zoom"
  | "Spin clockwise"
  | "Spin counterclockwise"
  | "Flip horizontal"
  | "Flip vertical"
  | "Whip left"
  | "Whip right"
  | "Whip up"
  | "Whip down"
  | "Blur"
  | "Circle"
  | "Iris close"
  | "Diamond"
  | "Heart"
  | "Star"
  | "Clock clockwise"
  | "Clock counterclockwise"
  | "Split horizontal"
  | "Split vertical"
  | "Blinds horizontal"
  | "Blinds vertical"
  | "Checkerboard"
  | "Diagonal stripes"
  | "Shutter"
  | "Glitch";
export type AnimationName =
  | "None"
  | "Fade"
  | "Rise"
  | "Drop"
  | "Slide"
  | "Slide right"
  | "Pop"
  | "Zoom"
  | "Shrink"
  | "Spin"
  | "Flip"
  | "Bounce"
  | "Elastic"
  | "Blur"
  | "Wipe left"
  | "Wipe right"
  | "Wipe up"
  | "Wipe down"
  | "Typewriter"
  | "Letter Pop In"
  | "Drift"
  | "Custom";
export const COMBO_ANIMATIONS = [
  "Zoom",
  "Wave",
  "Pulse",
  "Float",
  "Rock",
  "Shake",
  "Heartbeat",
  "Spin",
  "Breathe",
  "Jelly",
] as const;
export type ComboAnimationName = (typeof COMBO_ANIMATIONS)[number];
export type ComboAnimation = {
  name: ComboAnimationName;
  /** Loop rate multiplier, with 1 as the default. */
  speed: number;
  /** Strength from 0 to 100 percent. */
  amount: number;
};
export function makeComboAnimation(name: ComboAnimationName): ComboAnimation {
  return {
    name,
    speed: name === "Zoom" || name === "Breathe" ? 0.5 : name === "Wave" || name === "Float" ? 0.7 : 1,
    amount: name === "Shake" || name === "Spin" ? 35 : 50,
  };
}
export function normalizeComboAnimations(value: unknown): ComboAnimation[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<ComboAnimationName>();
  return value.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const layer = raw as Partial<ComboAnimation>;
    if (!COMBO_ANIMATIONS.includes(layer.name as ComboAnimationName) || seen.has(layer.name as ComboAnimationName)) return [];
    const name = layer.name as ComboAnimationName;
    seen.add(name);
    return [{
      name,
      speed: clamp(Number(layer.speed ?? 1), 0.1, 4),
      amount: clamp(Number(layer.amount ?? 50), 0, 100),
    }];
  });
}
export type TextAnimationOptions = {
  /** 0° moves right, 90° down. Used by directional presets and Custom. */
  angle?: number;
  /** Distance as a fraction of the canvas width/height. */
  distance?: number;
  /** Hidden scale offset from 1; 0.7 means 30% or 170%, depending on direction. */
  zoomAmount?: number;
  zoomDirection?: "in" | "out";
  rotation?: number;
  blur?: number;
  fade?: boolean;
  easing?: "ease-out" | "ease-in-out" | "linear" | "ease-in";
};
export type AnimationLayer = { name: AnimationName; settings: TextAnimationOptions };
export type Asset = {
  id: string;
  name: string;
  kind: MediaKind;
  duration: number;
  url?: string;
  thumbnail?: string;
  waveform?: number[];
  waveformPeaks?: number[];
  /** Absolute decoded sample peak used for non-destructive gain normalization. */
  audioPeak?: number;
  width?: number;
  height?: number;
  sizeLabel: string;
  theme: string;
};
export type Keyframe = {
  time: number;
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
};
export type PropertyKeyframe = { time: number; value: number | string | boolean };
export type PropertyKeyframes = Record<string, PropertyKeyframe[]>;
export type TextFillMode = "solid" | "linear" | "radial";
export type GradientStop = { id: string; position: number; color: string };
export const DEFAULT_GRADIENT_STOPS: GradientStop[] = [
  { id: "start", position: 0, color: "#ffffff" },
  { id: "end", position: 1, color: "#80efc1" },
];
export function normalizeGradientStops(value: unknown): GradientStop[] {
  if (!Array.isArray(value)) return DEFAULT_GRADIENT_STOPS.map((stop) => ({ ...stop }));
  const seen = new Set<string>();
  const stops = value.slice(0, 8).flatMap((raw, index) => {
    if (!raw || typeof raw !== "object") return [];
    const stop = raw as Partial<GradientStop>;
    if (typeof stop.color !== "string" || !/^#[0-9a-f]{6}$/i.test(stop.color)) return [];
    let id = typeof stop.id === "string" && stop.id ? stop.id : `stop-${index}`;
    if (seen.has(id)) id = `${id}-${index}`;
    seen.add(id);
    return [{ id, color: stop.color, position: clamp(Number(stop.position), 0, 1) }];
  }).sort((a, b) => a.position - b.position);
  return stops.length >= 2 ? stops : DEFAULT_GRADIENT_STOPS.map((stop) => ({ ...stop }));
}
export type Clip = VisualCompositing & ColorGrading & {
  id: string;
  assetId: string;
  label: string;
  kind: "video" | "audio";
  start: number;
  track: number;
  sourceStart: number;
  sourceEnd: number;
  /** Hold this source frame for the entire clip, including during export. */
  frozenAt?: number;
  speed: number;
  volume: number;
  /** Stereo balance: -1 is left, 0 is centered, 1 is right. */
  audioPan?: number;
  fadeIn: number;
  fadeOut: number;
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
  animation?: AnimationName;
  /** Magnetically align the visible media center while dragging in the player. */
  snapToGuides?: boolean;
  comboAnimations?: ComboAnimation[];
  animationDuration?: number;
  animationSettings?: TextAnimationOptions;
  animationStack?: AnimationLayer[];
  animationPresetName?: string;
  exitAnimation?: AnimationName;
  exitAnimationDuration?: number;
  exitAnimationSettings?: TextAnimationOptions;
  exitAnimationStack?: AnimationLayer[];
  exitAnimationPresetName?: string;
  flipX: boolean;
  flipY: boolean;
  fit: "cover" | "contain";
  /** Distinguishes a chosen crop from the old default for imported stills. */
  fitExplicit?: boolean;
  /** Non-destructive normalized source rectangle, before fit/transform/effects. */
  crop?: SourceCrop;
  filter: string;
  brightness: number;
  contrast: number;
  saturation: number;
  temperature: number;
  transition: TransitionName;
  transitionDuration: number;
  effects: { name: EffectName; amount: number; waves?: number }[];
  keyframes: Keyframe[];
  propertyKeyframes?: PropertyKeyframes;
};
export type TextClip = VisualCompositing & {
  id: string;
  text: string;
  label: string;
  start: number;
  duration: number;
  track: number;
  kind: "text" | "caption" | "sticker";
  x: number;
  y: number;
  /** Snap the visible text bounds to the canvas center while dragging. */
  snapToGuides?: boolean;
  rotation: number;
  fontSize: number;
  fontFamily: string;
  fontWeight: number;
  italic: boolean;
  color: string;
  fillMode: TextFillMode;
  gradientAngle: number;
  gradientCenterX: number;
  gradientCenterY: number;
  gradientRadius: number;
  gradientStops: GradientStop[];
  align: "left" | "center" | "right";
  lineHeight: number;
  letterSpacing: number;
  opacity: number;
  strokeColor: string;
  strokeWidth: number;
  shadowColor: string;
  shadowBlur: number;
  shadowOffset: number;
  background: boolean;
  backgroundColor: string;
  backgroundOpacity: number;
  padding: number;
  radius: number;
  animation: AnimationName;
  comboAnimations?: ComboAnimation[];
  animationDuration: number;
  animationSettings?: TextAnimationOptions;
  animationStack?: AnimationLayer[];
  animationPresetName?: string;
  exitAnimation: AnimationName;
  exitAnimationDuration: number;
  exitAnimationSettings?: TextAnimationOptions;
  exitAnimationStack?: AnimationLayer[];
  exitAnimationPresetName?: string;
  effects: Clip["effects"];
  fadeOut: number;
  propertyKeyframes?: PropertyKeyframes;
};
export type TimelineMarker = { id: string; kind: "beat" | "moment"; time: number };
export type Project = {
  version: 3;
  layerCount: number;
  id: string;
  name: string;
  ratio: Ratio;
  fps: number;
  background: string;
  assets: Asset[];
  clips: Clip[];
  texts: TextClip[];
  /** Playhead guides for beats and important moments; never affect playback/export timing. */
  markers: TimelineMarker[];
  mutedTracks: string[];
  hiddenTracks: string[];
  /** Protected layers remain visible/playable but reject editing until unlocked. */
  lockedTracks: string[];
};
export type Selection = { kind: "clip" | "text"; id: string } | null;
export const FPS = 30;
export const MIN_DURATION = 1 / 60;
export const clamp = (v: number, min: number, max: number) =>
  Math.max(min, Math.min(Number.isFinite(v) ? v : min, max));
export const uid = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
export const roundFrame = (v: number, fps = FPS) => Math.round(v * fps) / fps;
export const clipDuration = (clip: Clip) =>
  Math.max(MIN_DURATION, (clip.sourceEnd - clip.sourceStart) / clip.speed);
export const endOf = (item: Clip | TextClip) =>
  item.start + ("sourceEnd" in item ? clipDuration(item) : item.duration);
/** The visual clip underneath an incoming clip at its start on the same layer. */
export function transitionSource(p: Project, incoming: Clip): Clip | undefined {
  if (incoming.kind !== "video") return undefined;
  return p.clips
    .filter((c) =>
      c.kind === "video" &&
      c.track === incoming.track &&
      c.id !== incoming.id &&
      c.start < incoming.start - 1e-8 &&
      endOf(c) >= incoming.start - 1 / p.fps - 1e-8,
    )
    .sort((a, b) => a.start - b.start)
    .at(-1);
}
/** A transition straddles the cut and draws both source clips throughout this window. */
export function transitionWindow(p: Project, incoming: Clip) {
  if (incoming.transition === "None") return undefined;
  const previous = transitionSource(p, incoming);
  if (!previous) return undefined;
  const duration = Math.min(incoming.transitionDuration, clipDuration(incoming), clipDuration(previous));
  if (!(duration > 0)) return undefined;
  return { previous, duration, start: incoming.start - duration / 2, end: incoming.start + duration / 2 };
}
export function setJoinTransition(
  p: Project,
  incomingId: string,
  name: TransitionName,
): Project {
  const incoming = p.clips.find((c) => c.id === incomingId);
  if (!incoming || incoming.kind !== "video") return p;
  const previous = transitionSource(p, incoming);
  if (name !== "None" && !previous) return p;
  const maxDuration = Math.min(
    3,
    clipDuration(incoming),
    previous ? clipDuration(previous) : 3,
  );
  const duration = clamp(incoming.transitionDuration || 0.6, 1 / p.fps, maxDuration);
  if (incoming.transition === name && incoming.transitionDuration === duration) return p;
  return {
    ...p,
    clips: p.clips.map((c) => c.id === incomingId
      ? { ...c, transition: name, transitionDuration: duration }
      : c,
    ),
  };
}
export const projectDuration = (p: Project) =>
  Math.max(0, ...p.clips.map(endOf), ...p.texts.map(endOf));
export const trackKey = (item: Clip | TextClip) => `layer:${item.track}`;
export const layerCount = (p: Project) =>
  Math.max(
    2,
    p.layerCount,
    ...[...p.clips, ...p.texts].map((c) => c.track + 1),
  );
export function insertLayer(p: Project, at: number): Project {
  const index = Math.floor(clamp(at, 0, layerCount(p)));
  const shift = <T extends Clip | TextClip>(item: T): T =>
    item.track >= index ? { ...item, track: item.track + 1 } : item;
  const flags = (keys: string[]) =>
    keys.map((key) => {
      const track = Number(key.split(":")[1]);
      return `layer:${track >= index ? track + 1 : track}`;
    });
  return {
    ...p,
    layerCount: layerCount(p) + 1,
    clips: p.clips.map(shift),
    texts: p.texts.map(shift),
    hiddenTracks: flags(p.hiddenTracks),
    mutedTracks: flags(p.mutedTracks),
    lockedTracks: flags(p.lockedTracks ?? []),
  };
}
export function moveToLayer(
  p: Project,
  selection: Selection,
  track: number,
): Project {
  if (!selection) return p;
  // Moving below the bottom creates a real layer, preserving everyone else's order.
  const next = track < 0 ? insertLayer(p, 0) : p;
  const target = Math.max(0, track);
  return {
    ...next,
    layerCount: Math.max(layerCount(next), target + 1),
    clips: next.clips.map((c) =>
      selection.kind === "clip" && c.id === selection.id
        ? { ...c, track: target }
        : c,
    ),
    texts: next.texts.map((t) =>
      selection.kind === "text" && t.id === selection.id
        ? { ...t, track: target }
        : t,
    ),
  };
}
export const clock = (t: number, frames = false, fps = FPS) => {
  const n = Math.max(0, Math.round(t * fps));
  const seconds = Math.floor(n / fps);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}${frames ? ":" + String(n % fps).padStart(2, "0") : ""}`;
};
export const dimensions = (ratio: Ratio, resolution = 1080) => {
  const [a, b] = ratio.split(":").map(Number);
  const even = (n: number) => Math.round(n / 2) * 2;
  return a >= b
    ? { width: even((resolution * a) / b), height: resolution }
    : { width: resolution, height: even((resolution * b) / a) };
};
export function makeClip(asset: Asset, start = 0, track = 0): Clip {
  return {
    ...DEFAULT_COMPOSITING,
    id: uid("clip"),
    assetId: asset.id,
    label: asset.name,
    kind: asset.kind === "audio" ? "audio" : "video",
    start,
    track,
    sourceStart: 0,
    sourceEnd: asset.duration,
    speed: 1,
    volume: 1,
    audioPan: 0,
    fadeIn: 0,
    fadeOut: 0,
    x: 0,
    y: 0,
    scale: 1,
    rotation: 0,
    opacity: 1,
    snapToGuides: true,
    animation: "None",
    comboAnimations: [],
    animationDuration: 0.5,
    exitAnimation: "None",
    exitAnimationDuration: 0.5,
    flipX: false,
    flipY: false,
    fit: asset.kind === "image" ? "contain" : "cover",
    crop: { ...FULL_CROP },
    filter: "Original",
    brightness: 100,
    contrast: 100,
    saturation: 100,
    temperature: 0,
    ...GRADE_DEFAULTS,
    gradingEnabled: true,
    colorCurves: identityCurves(),
    transition: "None",
    transitionDuration: 0.6,
    effects: [],
    keyframes: [],
    propertyKeyframes: {},
  };
}
export function makeText(start = 0, patch: Partial<TextClip> = {}): TextClip {
  return {
    ...DEFAULT_COMPOSITING,
    id: uid("text"),
    text: "New Text",
    label: "Text",
    start,
    duration: 4,
    track: 0,
    kind: "text",
    x: 0.5,
    y: 0.5,
    snapToGuides: true,
    rotation: 0,
    fontSize: 72,
    fontFamily: "Manrope Variable",
    fontWeight: 700,
    italic: false,
    color: "#ffffff",
    fillMode: "solid",
    gradientAngle: 0,
    gradientCenterX: 0.5,
    gradientCenterY: 0.5,
    gradientRadius: 0.7,
    gradientStops: DEFAULT_GRADIENT_STOPS.map((stop) => ({ ...stop })),
    align: "center",
    lineHeight: 1.2,
    letterSpacing: 0,
    opacity: 1,
    strokeColor: "#080b12",
    strokeWidth: 0,
    shadowColor: "#000000",
    shadowBlur: 14,
    shadowOffset: 3,
    background: false,
    backgroundColor: "#10141b",
    backgroundOpacity: 0.8,
    padding: 20,
    radius: 12,
    animation: "None",
    comboAnimations: [],
    animationDuration: 0.5,
    exitAnimation: "None",
    exitAnimationDuration: 0.5,
    effects: [],
    fadeOut: 0,
    propertyKeyframes: {},
    ...patch,
  };
}
export function newProject(): Project {
  return {
    version: 3,
    layerCount: 4,
    id: uid("project"),
    name: "Untitled project",
    ratio: "16:9",
    fps: 30,
    background: "#080b11",
    assets: [],
    clips: [],
    texts: [],
    markers: [],
    mutedTracks: [],
    hiddenTracks: [],
    lockedTracks: [],
  };
}
export function toggleTimelineMarker(project: Project, time: number, kind: TimelineMarker["kind"]): Project {
  const frameTime = roundFrame(Math.max(0, time), project.fps);
  const existing = project.markers.find((marker) => marker.kind === kind && Math.abs(marker.time - frameTime) < 0.5 / project.fps);
  return {
    ...project,
    markers: existing
      ? project.markers.filter((marker) => marker.id !== existing.id)
      : [...project.markers, { id: uid("marker"), kind, time: frameTime }].sort((a, b) => a.time - b.time),
  };
}
export function splitItem(
  p: Project,
  selection: Selection,
  time: number,
): { project: Project; selection: Selection } {
  if (!selection) return { project: p, selection };
  const item =
    selection.kind === "clip"
      ? p.clips.find((c) => c.id === selection.id)
      : p.texts.find((c) => c.id === selection.id);
  if (
    !item ||
    time - item.start < 1 / p.fps - 1e-8 ||
    endOf(item) - time < 1 / p.fps - 1e-8
  )
    return { project: p, selection };
  const cut = clamp(
    roundFrame(time - item.start, p.fps),
    1 / p.fps,
    endOf(item) - item.start - 1 / p.fps,
  );
  const rightId = uid(selection.kind);
  if ("sourceEnd" in item) {
    const sourceCut = item.sourceStart + cut * item.speed;
    // Keep out-of-range support keys so splitting does not alter the original motion curve.
    const left = { ...item, sourceEnd: sourceCut, fadeOut: 0, exitAnimation: "None" as const, exitAnimationStack: [] };
    const right = {
      ...item,
      id: rightId,
      start: item.start + cut,
      sourceStart: sourceCut,
      transition: "None" as const,
      fadeIn: 0,
      animation: "None" as const,
      animationStack: [],
      keyframes: item.keyframes.map((k) => ({ ...k, time: k.time - cut })),
      propertyKeyframes: shiftPropertyKeyframes(item.propertyKeyframes, -cut),
    };
    return {
      project: {
        ...p,
        clips: p.clips.flatMap((c) => (c.id === item.id ? [left, right] : [c])),
      },
      selection: { kind: "clip", id: rightId },
    };
  }
  const left = {
    ...item,
    duration: cut,
    fadeOut: 0,
    exitAnimation: "None" as const,
    exitAnimationStack: [],
  };
  const right = {
    ...item,
    id: rightId,
    start: item.start + cut,
    duration: item.duration - cut,
    animation: "None" as const,
    animationStack: [],
    propertyKeyframes: shiftPropertyKeyframes(item.propertyKeyframes, -cut),
  };
  return {
    project: {
      ...p,
      texts: p.texts.flatMap((c) => (c.id === item.id ? [left, right] : [c])),
    },
    selection: { kind: "text", id: rightId },
  };
}
export function freezeFrame(
  p: Project,
  selection: Selection,
  time: number,
  hold = 2,
): { project: Project; selection: Selection } {
  if (selection?.kind !== "clip") return { project: p, selection };
  const clip = p.clips.find((c) => c.id === selection.id);
  const asset = p.assets.find((a) => a.id === clip?.assetId);
  if (!clip || clip.kind !== "video" || asset?.kind !== "video" || clip.frozenAt !== undefined)
    return { project: p, selection };
  const split = splitItem(p, selection, time);
  if (split.project === p || split.selection?.kind !== "clip")
    return { project: p, selection };
  const rightId = split.selection.id;
  const right = split.project.clips.find((c) => c.id === rightId)!;
  const frame = right.sourceStart;
  const duration = Math.max(1 / p.fps, roundFrame(hold, p.fps));
  const transform = interpolatedTransform(clip, right.start - clip.start);
  const still: Clip = {
    ...structuredClone(clip),
    ...transform,
    id: uid("clip"),
    label: `${clip.label} · Freeze`,
    start: right.start,
    sourceStart: frame,
    sourceEnd: frame + duration,
    speed: 1,
    frozenAt: frame,
    volume: 0,
    fadeIn: 0,
    fadeOut: 0,
    transition: "None",
    animation: "None",
    exitAnimation: "None",
    comboAnimations: [],
    animationStack: [],
    exitAnimationStack: [],
    keyframes: [],
    propertyKeyframes: {},
  };
  const at = right.start;
  return {
    project: {
      ...split.project,
      clips: [...split.project.clips.map((c) =>
        c.track === clip.track && c.start >= at - 1e-8
          ? { ...c, start: c.start + duration }
          : c,
      ), still],
      texts: split.project.texts.map((t) =>
        t.track === clip.track && t.start >= at - 1e-8
          ? { ...t, start: t.start + duration }
          : t,
      ),
    },
    selection: { kind: "clip", id: still.id },
  };
}
export function trimItem<T extends Clip | TextClip>(
  item: T,
  edge: "left" | "right",
  delta: number,
  asset?: Asset,
  fps = FPS,
): T {
  const minimum = 1 / fps;
  if ("sourceEnd" in item) {
    if (edge === "left") {
      const d = clamp(
        delta,
        -Math.min(item.start, item.sourceStart / item.speed),
        clipDuration(item) - minimum,
      );
      return {
        ...item,
        start: item.start + d,
        sourceStart: item.sourceStart + d * item.speed,
        keyframes: item.keyframes.map((k) => ({ ...k, time: k.time - d })),
        propertyKeyframes: shiftPropertyKeyframes(item.propertyKeyframes, -d),
      };
    }
    const max =
      item.frozenAt !== undefined || asset?.kind === "image" || asset?.kind === "demo"
        ? 3600
        : (asset?.duration ?? item.sourceEnd);
    return {
      ...item,
      sourceEnd: clamp(
        item.sourceEnd + delta * item.speed,
        item.sourceStart + minimum * item.speed,
        max,
      ),
    };
  }
  if (edge === "left") {
    const d = clamp(delta, -item.start, item.duration - minimum);
    return { ...item, start: item.start + d, duration: item.duration - d, propertyKeyframes: shiftPropertyKeyframes(item.propertyKeyframes, -d) };
  }
  return { ...item, duration: Math.max(minimum, item.duration + delta) };
}
export function snapPosition(
  start: number,
  duration: number,
  points: number[],
  threshold: number,
  enabled = true,
  fps = FPS,
) {
  let position = Math.max(0, roundFrame(start, fps));
  let guide: number | null = null;
  let best = threshold;
  if (enabled)
    for (const point of points)
      for (const candidate of [point, point - duration]) {
        if (candidate >= 0 && Math.abs(candidate - start) < best) {
          best = Math.abs(candidate - start);
          position = candidate;
          guide = point;
        }
      }
  return { position, guide };
}
export function interpolatedTransform(
  c: Clip,
  time: number,
): Omit<Keyframe, "time"> {
  const base = {
    x: c.x,
    y: c.y,
    scale: c.scale,
    rotation: c.rotation,
    opacity: c.opacity,
  };
  if (!c.keyframes.length) return animatedProperties(c, time, base);
  const keys = [...c.keyframes].sort((a, b) => a.time - b.time);
  const before = [...keys].reverse().find((k) => k.time <= time) ?? keys[0];
  const after = keys.find((k) => k.time >= time) ?? keys.at(-1)!;
  const linear =
    before.time === after.time
      ? 0
      : clamp((time - before.time) / (after.time - before.time), 0, 1);
  const t = linear * linear * (3 - 2 * linear);
  const legacy = Object.fromEntries(
    Object.keys(base).map((k) => {
      const key = k as keyof typeof base;
      return [key, before[key] + (after[key] - before[key]) * t];
    }),
  ) as typeof base;
  return animatedProperties(c, time, legacy);
}
export function shiftPropertyKeyframes(tracks: PropertyKeyframes | undefined, delta: number): PropertyKeyframes {
  return Object.fromEntries(Object.entries(tracks ?? {}).map(([name, keys]) => [name, keys.map((key) => ({ ...key, time: key.time + delta }))]));
}
export function propertyValue(item: Clip | TextClip, name: string, localTime: number): number | string | boolean | undefined {
  const keys = item.propertyKeyframes?.[name];
  if (!keys?.length) return undefined;
  const sorted = [...keys].sort((a, b) => a.time - b.time);
  const before = [...sorted].reverse().find((key) => key.time <= localTime) ?? sorted[0];
  const after = sorted.find((key) => key.time >= localTime) ?? sorted.at(-1)!;
  if (before === after || before.time === after.time) return before.value;
  const t = clamp((localTime - before.time) / (after.time - before.time), 0, 1);
  const eased = t * t * (3 - 2 * t);
  if (typeof before.value === "number" && typeof after.value === "number")
    return before.value + (after.value - before.value) * eased;
  if (typeof before.value === "string" && typeof after.value === "string" && /^#[0-9a-f]{6}$/i.test(before.value) && /^#[0-9a-f]{6}$/i.test(after.value)) {
    const first = before.value, last = after.value;
    const channel = (offset: number) => Math.round(parseInt(first.slice(offset, offset + 2), 16) * (1 - eased) + parseInt(last.slice(offset, offset + 2), 16) * eased).toString(16).padStart(2, "0");
    return `#${channel(1)}${channel(3)}${channel(5)}`;
  }
  return t < 1 ? before.value : after.value;
}
export function animatedProperties<T extends Clip | TextClip, V extends object>(item: T, localTime: number, base: V): V {
  const values = { ...base } as Record<string, unknown>;
  for (const name of Object.keys(item.propertyKeyframes ?? {})) {
    if (name.startsWith("effect:")) continue;
    const value = propertyValue(item, name, localTime);
    if (value !== undefined && name in values) values[name] = value;
  }
  return values as V;
}
export function animatedItem<T extends Clip | TextClip>(item: T, timelineTime: number): T {
  const local = timelineTime - item.start;
  const result = animatedProperties(item, local, item);
  result.effects = item.effects.map((effect) => ({
    ...effect,
    amount: Number(propertyValue(item, `effect:${effect.name}`, local) ?? effect.amount),
  }));
  if ("gradientStops" in item) {
    (result as TextClip).gradientStops = item.gradientStops.map((stop) => ({
      ...stop,
      color: String(propertyValue(item, `gradientStop:${stop.id}:color`, local) ?? stop.color),
      position: Number(propertyValue(item, `gradientStop:${stop.id}:position`, local) ?? stop.position),
    }));
  }
  return result;
}
export function togglePropertyKeyframe<T extends Clip | TextClip>(item: T, name: string, localTime: number, value: number | string | boolean, fps = FPS): T {
  const time = roundFrame(clamp(localTime, 0, endOf(item) - item.start), fps);
  const old = item.propertyKeyframes?.[name] ?? [];
  const exists = old.some((key) => Math.abs(key.time - time) < 0.5 / fps);
  const next = exists ? old.filter((key) => Math.abs(key.time - time) >= 0.5 / fps) : [...old, { time, value }].sort((a, b) => a.time - b.time);
  return { ...item, propertyKeyframes: { ...item.propertyKeyframes, [name]: next } };
}
export function setPropertyKeyframe<T extends Clip | TextClip>(item: T, name: string, localTime: number, value: number | string | boolean, fps = FPS): T {
  const time = roundFrame(clamp(localTime, 0, endOf(item) - item.start), fps);
  const old = item.propertyKeyframes?.[name] ?? [];
  return { ...item, propertyKeyframes: { ...item.propertyKeyframes, [name]: [...old.filter((key) => Math.abs(key.time - time) >= 0.5 / fps), { time, value }].sort((a, b) => a.time - b.time) } };
}
export function parseSrt(content: string): TextClip[] {
  const time = (s: string) => {
    const m = s.trim().match(/(\d+):(\d+):(\d+)[,.](\d{1,3})/);
    return m
      ? +m[1] * 3600 + +m[2] * 60 + +m[3] + Number(m[4].padEnd(3, "0")) / 1000
      : NaN;
  };
  return content
    .replace(/\r/g, "")
    .trim()
    .split(/\n\s*\n/)
    .flatMap((block) => {
      const lines = block.split("\n");
      const i = lines.findIndex((l) => l.includes("-->"));
      if (i < 0) return [];
      const [start, end] = lines[i].split("-->").map(time);
      const text = lines
        .slice(i + 1)
        .join("\n")
        .replace(/<[^>]*>/g, "");
      return Number.isFinite(start) && end > start && text
        ? [
            makeText(start, {
              text,
              duration: end - start,
              kind: "caption",
              fontSize: 48,
              y: 0.84,
              background: true,
            }),
          ]
        : [];
    });
}
// Migrate the earlier sequential timeline without changing the user's edit or deleting its media.
export function migrateProject(raw: unknown, restoredAssets: Asset[]): Project {
  if (!raw || typeof raw !== "object")
    throw new Error("This file does not contain a Cutline project.");
  const r = raw as Record<string, unknown>;
  const p = newProject();
  // Retire built-in samples from old projects/backups without changing imports
  // or user-authored text. Missing sample references are dropped below.
  const assets = restoredAssets.filter((a) => a.kind !== "demo");
  const retiredSamples = new Set([
    "demo-aurora", "demo-alpine", "demo-city",
    ...restoredAssets.filter((a) => a.kind === "demo").map((a) => a.id),
  ]);
  const valid = new Map(assets.map((a) => [a.id, a]));
  let cursor = 0;
  const clips = [
    ...(Array.isArray(r.clips) ? r.clips : []),
    ...(Array.isArray(r.audioClips) ? r.audioClips : []),
  ].flatMap((old: Record<string, unknown>) => {
    const asset = valid.get(String(old.assetId));
    if (!asset) {
      // The earliest projects stored sequential clips without a start time.
      // Leave the removed sample's gap so later imported clips don't shift.
      if (retiredSamples.has(String(old.assetId))) {
        const start = typeof old.start === "number" ? Math.max(0, old.start) : cursor;
        const duration = Math.max(0, (Number(old.sourceEnd) || 0) - (Number(old.sourceStart) || 0));
        cursor = start + duration / clamp(Number(old.speed) || 1, 0.25, 4);
      }
      return [];
    }
    const c = { ...makeClip(asset), ...old } as Clip;
    // A detached audio lane intentionally references the original video asset.
    c.kind = asset.kind === "audio" || (asset.kind === "video" && old.kind === "audio") ? "audio" : "video";
    if (r.version !== 2 && r.version !== 3) {
      c.x /= 100;
      c.y /= 100;
    }
    c.start =
      typeof old.start === "number"
        ? Math.max(0, old.start)
        : c.kind === "video"
          ? cursor
          : 0;
    c.speed = clamp(Number(c.speed), 0.25, 4);
    c.track = Math.floor(clamp(Number(c.track), 0, 9999));
    c.sourceStart = Math.max(0, Number(c.sourceStart) || 0);
    c.sourceEnd = Math.max(
      c.sourceStart + MIN_DURATION,
      Number(c.sourceEnd) || asset.duration,
    );
    c.effects = Array.isArray(c.effects) ? c.effects : [];
    Object.assign(c, normalizeCompositing(c));
    Object.assign(c, normalizeGrade(c));
    c.audioPan = typeof c.audioPan === "number" && Number.isFinite(c.audioPan) ? clamp(c.audioPan, -1, 1) : 0;
    c.comboAnimations = normalizeComboAnimations(c.comboAnimations);
    c.keyframes = Array.isArray(c.keyframes) ? c.keyframes : [];
    c.propertyKeyframes = c.propertyKeyframes && typeof c.propertyKeyframes === "object" ? c.propertyKeyframes : {};
    c.crop = normalizeCrop(c.crop);
    if (asset.kind === "image" && c.fit === "cover" && !c.fitExplicit && !c.propertyKeyframes.fit?.length) c.fit = "contain";
    c.animation = typeof c.animation === "string" ? c.animation : "None";
    c.exitAnimation = typeof c.exitAnimation === "string" ? c.exitAnimation : "None";
    c.animationDuration = Number.isFinite(c.animationDuration) ? c.animationDuration : 0.5;
    c.exitAnimationDuration = Number.isFinite(c.exitAnimationDuration) ? c.exitAnimationDuration : 0.5;
    c.filter = c.filter === "None" ? "Original" : c.filter;
    if (String(c.transition) === "Fade") c.transition = "Dissolve";
    if (String(c.transition) === "Wipe") c.transition = "Wipe left";
    if (c.kind === "video") cursor = endOf(c);
    return [c];
  });
  const texts = (Array.isArray(r.texts) ? r.texts : []).map(
    (old: Record<string, unknown>) => {
      const t = { ...makeText(0), ...old } as TextClip;
      if (r.version !== 2 && r.version !== 3) {
        t.duration = Math.max(MIN_DURATION, Number(old.end) - t.start);
        t.fontSize *= 2;
      }
      t.duration = Math.max(MIN_DURATION, t.duration);
      t.track = Math.floor(clamp(Number(t.track), 0, 9999));
      t.effects = Array.isArray(t.effects) ? t.effects : [];
      Object.assign(t, normalizeCompositing(t));
      t.comboAnimations = normalizeComboAnimations(t.comboAnimations);
      t.fillMode = t.fillMode === "linear" || t.fillMode === "radial" ? t.fillMode : "solid";
      t.gradientAngle = clamp(Number(t.gradientAngle), 0, 360);
      t.gradientCenterX = clamp(Number(t.gradientCenterX), 0, 1);
      t.gradientCenterY = clamp(Number(t.gradientCenterY), 0, 1);
      t.gradientRadius = clamp(Number(t.gradientRadius), 0.1, 2);
      t.gradientStops = normalizeGradientStops(t.gradientStops);
      t.propertyKeyframes = t.propertyKeyframes && typeof t.propertyKeyframes === "object" ? t.propertyKeyframes : {};
      // Preserve the old exit-fade setting when opening older projects/backups.
      if (typeof old.exitAnimation !== "string" && t.fadeOut > 0) {
        t.exitAnimation = "Fade";
        t.exitAnimationDuration = t.fadeOut;
      }
      return t;
    },
  );
  let mutedTracks: string[] = Array.isArray(r.mutedTracks)
    ? r.mutedTracks.filter((k) => typeof k === "string")
    : [];
  let hiddenTracks: string[] = Array.isArray(r.hiddenTracks)
    ? r.hiddenTracks.filter((k) => typeof k === "string")
    : [];
  let lockedTracks: string[] = Array.isArray(r.lockedTracks)
    ? r.lockedTracks.filter((k) => typeof k === "string")
    : [];
  let count = Math.max(
    2,
    Math.floor(clamp(Number(r.layerCount) || 4, 2, 10000)),
    ...[...clips, ...texts].map((c) => c.track + 1),
  );
  if (r.version !== 3) {
    // Older projects had three independent namespaces, with ALL text above ALL video.
    // Compact them into universal layers in that same order, including hidden/muted lanes.
    const oldKey = (c: Clip | TextClip) =>
      `${"assetId" in c ? c.kind : "text"}:${c.track}`;
    const keys = [
      ...new Set(
        [...clips, ...texts].map(oldKey).concat(mutedTracks, hiddenTracks, lockedTracks),
      ),
    ]
      .filter((k) => /^(audio|video|text):\d+$/.test(k))
      .sort((a, b) => {
        const [ak, an] = a.split(":"),
          [bk, bn] = b.split(":");
        const rank = ["audio", "video", "text"];
        return (
          rank.indexOf(ak) - rank.indexOf(bk) ||
          (ak === "audio" ? +bn - +an : +an - +bn)
        );
      });
    const mapping = new Map(keys.map((k, i) => [k, i + 1]));
    for (const item of [...clips, ...texts])
      item.track = mapping.get(oldKey(item))!;
    const remap = (flags: string[]) =>
      flags.filter((k) => mapping.has(k)).map((k) => `layer:${mapping.get(k)}`);
    mutedTracks = remap(mutedTracks);
    hiddenTracks = remap(hiddenTracks);
    lockedTracks = remap(lockedTracks);
    count = Math.max(4, keys.length + 2);
  }
  return {
    ...p,
    id: typeof r.id === "string" ? r.id : p.id,
    name: String(r.name ?? r.projectName ?? "Untitled project"),
    ratio: ["16:9", "9:16", "1:1", "4:5"].includes(String(r.ratio))
      ? (r.ratio as Ratio)
      : "16:9",
    background: typeof r.background === "string" ? r.background : p.background,
    fps: Number(r.fps) === 60 ? 60 : 30,
    assets,
    clips,
    texts,
    layerCount: count,
    mutedTracks,
    hiddenTracks,
    lockedTracks: [...new Set(lockedTracks)].filter((key) => /^layer:\d+$/.test(key) && Number(key.split(":")[1]) < count),
    markers: (Array.isArray(r.markers) ? r.markers : []).flatMap((marker: Record<string, unknown>) => {
      if (!marker || typeof marker !== "object" || (marker.kind !== "beat" && marker.kind !== "moment") || typeof marker.time !== "number" || !Number.isFinite(marker.time)) return [];
      return [{ id: typeof marker.id === "string" && marker.id ? marker.id : uid("marker"), kind: marker.kind, time: roundFrame(Math.max(0, marker.time), Number(r.fps) === 60 ? 60 : 30) } as TimelineMarker];
    }).sort((a, b) => a.time - b.time),
  };
}
