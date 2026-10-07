import { animatedItem, clamp, setPropertyKeyframe, type Clip, type TextClip } from "./model";
import { normalizeCompositing, type MaskFrame, type MaskGeometry, type VisualCompositing } from "./visualCompositing";

/** Translate screen-space drags back into the mask's reference frame. */
export function maskDragPatch(item: VisualCompositing, frame: MaskFrame, geometry: MaskGeometry,
  mode: "move" | "size" | "rotate", dx: number, dy: number, angleDelta = 0): VisualCompositing {
  const m = normalizeCompositing(item);
  const radians = (mode === "size" ? geometry.rotation : frame.rotation) * Math.PI / 180;
  const x = Math.cos(radians) * dx + Math.sin(radians) * dy;
  const y = -Math.sin(radians) * dx + Math.cos(radians) * dy;
  if (mode === "move") return {
    maskX: clamp(m.maskX + x / Math.max(1, frame.width) * (frame.flipX ? -1 : 1), -2, 3),
    maskY: clamp(m.maskY + y / Math.max(1, frame.height) * (frame.flipY ? -1 : 1), -2, 3),
  };
  if (mode === "size") return {
    ...(m.maskShape === "Mirror" ? {} : { maskWidth: clamp(m.maskWidth + x * 2 / Math.max(1, frame.width), 0.01, 3) }),
    maskHeight: clamp(m.maskHeight + y * 2 / Math.max(1, frame.height), 0.01, 3),
  };
  return { maskRotation: clamp(m.maskRotation + angleDelta * (frame.flipX ? -1 : 1) * (frame.flipY ? -1 : 1), -3600, 3600) };
}
export function applyMaskPatch<T extends Clip | TextClip>(original: T, patch: VisualCompositing, time: number, fps: number): T {
  let next = { ...original };
  for (const [name, value] of Object.entries(patch)) {
    if (original.propertyKeyframes?.[name]?.length) next = setPropertyKeyframe(next, name, time - original.start, value, fps);
    else Object.assign(next, { [name]: value });
  }
  return next;
}
export function maskAtTime<T extends Clip | TextClip>(item: T, time: number) {
  return normalizeCompositing(animatedItem(item, time));
}
