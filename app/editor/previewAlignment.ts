import { interpolatedTransform, setPropertyKeyframe, type Clip, type TextClip } from "./model";

/** Snap in CSS pixels, so preview zoom and project resolution do not alter the magnet. */
export function snapCanvasCenter(x: number, y: number, offsetX: number, offsetY: number,
  target: number, width: number, height: number, enabled: boolean) {
  const snapX = enabled && Math.abs((x + offsetX - target) * width) <= 12;
  const snapY = enabled && Math.abs((y + offsetY - target) * height) <= 12;
  return { x: snapX ? target - offsetX : x, y: snapY ? target - offsetY : y, snapX, snapY };
}

/** Preview dragging edits the active property/motion keyframe, not an ignored base value. */
export function applyPreviewTransform<T extends Clip | TextClip>(item: T, patch: Partial<T>, time: number, fps: number): T {
  let next = { ...item, ...patch };
  if ("keyframes" in item && item.keyframes.length) {
    const local = Math.max(0, time - item.start);
    next = { ...next, keyframes: [...item.keyframes.filter((key) => Math.abs(key.time - local) > 1 / fps),
      { ...interpolatedTransform(item, local), ...patch, time: local }].sort((a, b) => a.time - b.time) };
  }
  for (const [name, value] of Object.entries(patch)) {
    if (item.propertyKeyframes?.[name]?.length && typeof value === "number")
      next = setPropertyKeyframe(next, name, time - item.start, value, fps);
  }
  return next;
}
