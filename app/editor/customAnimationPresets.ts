import { ANIMATIONS } from "./presets";
import { clamp, uid, type AnimationLayer, type AnimationName, type TextAnimationOptions } from "./model";

export type AnimationPhase = "Entrance" | "Exit";
export type CustomAnimationPreset = {
  id: string;
  name: string;
  phase: AnimationPhase;
  base: AnimationName;
  duration: number;
  settings: TextAnimationOptions;
  layers?: AnimationLayer[];
};

const STORAGE_KEY = "cutline:custom-animation-presets:v1";
const easing = ["ease-out", "ease-in-out", "linear", "ease-in", "back", "spring"];
export function sanitizeAnimationSettings(input: unknown): TextAnimationOptions {
  if (!input || typeof input !== "object") return {};
  const source = input as Record<string, unknown>;
  const result: TextAnimationOptions = {};
  for (const [name, min, max] of [
    ["angle", -360, 360], ["distance", 0, 1], ["zoomAmount", 0, 2],
    ["rotation", -720, 720], ["blur", 0, 0.1],
    ["delay", 0, 0.95], ["span", 0.01, 1], ["stagger", 0, 0.95], ["overshoot", 0, 1], ["seed", 0, 9999],
  ] as const) {
    if (typeof source[name] === "number" && Number.isFinite(source[name])) result[name] = clamp(source[name], min, max);
  }
  if (source.zoomDirection === "in" || source.zoomDirection === "out") result.zoomDirection = source.zoomDirection;
  if (typeof source.fade === "boolean") result.fade = source.fade;
  if (typeof source.easing === "string" && easing.includes(source.easing)) result.easing = source.easing as TextAnimationOptions["easing"];
  if (["letter", "word", "line"].includes(String(source.unit))) result.unit = source.unit as TextAnimationOptions["unit"];
  if (["forward", "reverse", "center-out", "edges-in", "random"].includes(String(source.order))) result.order = source.order as TextAnimationOptions["order"];
  if (source.flipAxis === "horizontal" || source.flipAxis === "vertical") result.flipAxis = source.flipAxis;
  if (result.seed !== undefined) result.seed = Math.round(result.seed);
  return result;
}
function sanitizeLayers(input: unknown): AnimationLayer[] {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 20).flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const layer = value as Record<string, unknown>;
    if (typeof layer.name !== "string" || layer.name === "None" || !ANIMATIONS.includes(layer.name as AnimationName)) return [];
    return [{ name: layer.name as AnimationName, settings: sanitizeAnimationSettings(layer.settings) }];
  });
}
export function parseCustomAnimationPresets(raw: string | null): CustomAnimationPreset[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, 50).flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const preset = value as Record<string, unknown>;
      if (typeof preset.id !== "string" || typeof preset.name !== "string" || !preset.name.trim() ||
          (preset.phase !== "Entrance" && preset.phase !== "Exit") || !ANIMATIONS.includes(preset.base as AnimationName)) return [];
      const layers = sanitizeLayers(preset.layers);
      return [{
        id: preset.id,
        name: preset.name.trim().slice(0, 42),
        phase: preset.phase,
        base: preset.base as AnimationName,
        duration: clamp(Number(preset.duration), 0.05, 60),
        settings: sanitizeAnimationSettings(preset.settings),
        ...(layers.length ? { layers } : {}),
      }];
    });
  } catch { return []; }
}
export function readCustomAnimationPresets(): CustomAnimationPreset[] {
  try { return parseCustomAnimationPresets(localStorage.getItem(STORAGE_KEY)); }
  catch { return []; }
}
export function writeCustomAnimationPresets(presets: CustomAnimationPreset[]): boolean {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(presets)); return true; }
  catch { return false; }
}
export function createCustomAnimationPreset(name: string, phase: AnimationPhase, base: AnimationName, duration: number, settings: TextAnimationOptions, layers?: AnimationLayer[]): CustomAnimationPreset {
  const sanitized = sanitizeLayers(layers);
  return { id: uid("animation"), name: name.trim().slice(0, 42), phase, base, duration: clamp(duration, 0.05, 60), settings: sanitizeAnimationSettings(settings), ...(sanitized.length ? { layers: sanitized } : {}) };
}
