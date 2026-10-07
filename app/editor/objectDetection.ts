import { normalizeCrop, type SourceCrop } from "./crop";
import type { VisualCompositing } from "./visualCompositing";
export const OBJECT_MODEL = "Xenova/yolos-tiny";
export type DetectedObject = { label: string; score: number; box: { xmin: number; ymin: number; xmax: number; ymax: number } };
/** Worker boxes are normalized relative to the cropped original source, not the viewer. */
export function normalizeDetections(raw: unknown, threshold = .35): DetectedObject[] {
  if (!Array.isArray(raw)) return [];
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  const candidates = raw.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const object = value as DetectedObject, box = object.box;
    if (typeof object.label !== "string" || !Number.isFinite(object.score) || object.score < threshold || object.score > 1 ||
      !box || ![box.xmin, box.ymin, box.xmax, box.ymax].every(Number.isFinite)) return [];
    const result = { xmin: clamp(box.xmin), ymin: clamp(box.ymin), xmax: clamp(box.xmax), ymax: clamp(box.ymax) };
    if (result.xmax - result.xmin < .002 || result.ymax - result.ymin < .002) return [];
    return [{ label: object.label.slice(0, 100), score: object.score, box: result }];
  }).sort((a, b) => b.score - a.score);
  // Remove duplicate hypotheses, not overlapping objects of different classes.
  const accepted: DetectedObject[] = [];
  for (const item of candidates) {
    const a = item.box;
    const duplicate = accepted.some((other) => {
      if (other.label !== item.label) return false;
      const b = other.box, intersection = Math.max(0, Math.min(a.xmax, b.xmax) - Math.max(a.xmin, b.xmin)) * Math.max(0, Math.min(a.ymax, b.ymax) - Math.max(a.ymin, b.ymin));
      const union = (a.xmax - a.xmin) * (a.ymax - a.ymin) + (b.xmax - b.xmin) * (b.ymax - b.ymin) - intersection;
      return intersection / Math.max(union, .000001) > .65;
    });
    if (!duplicate) accepted.push(item);
    if (accepted.length === 30) break;
  }
  return accepted;
}
export function detectionCrop(object: DetectedObject, existing: SourceCrop, padding = .05): SourceCrop {
  const box = object.box, x = Math.max(0, box.xmin - padding * (box.xmax - box.xmin)), y = Math.max(0, box.ymin - padding * (box.ymax - box.ymin));
  const endX = Math.min(1, box.xmax + padding * (box.xmax - box.xmin)), endY = Math.min(1, box.ymax + padding * (box.ymax - box.ymin));
  return normalizeCrop({ x: existing.x + x * existing.width, y: existing.y + y * existing.height,
    width: (endX - x) * existing.width, height: (endY - y) * existing.height });
}
export function detectionMask(object: DetectedObject, source: { width: number; height: number }, frame: { width: number; height: number }, fit: "cover" | "contain"): VisualCompositing {
  const box = object.box, scale = fit === "cover" ? Math.max(frame.width / source.width, frame.height / source.height) : Math.min(frame.width / source.width, frame.height / source.height);
  const width = source.width * scale, height = source.height * scale;
  // Contain's content bounds are the fitted image itself; cover's bounds are the crop frame.
  const refWidth = fit === "contain" ? width : frame.width, refHeight = fit === "contain" ? height : frame.height;
  return { maskShape: "Rectangle", maskSpace: "content", maskInvert: false, maskRotation: 0, maskFeather: .012,
    maskX: .5 + ((box.xmin + box.xmax) / 2 - .5) * width / refWidth,
    maskY: .5 + ((box.ymin + box.ymax) / 2 - .5) * height / refHeight,
    maskWidth: Math.min(3, (box.xmax - box.xmin) * width / refWidth), maskHeight: Math.min(3, (box.ymax - box.ymin) * height / refHeight) };
}
