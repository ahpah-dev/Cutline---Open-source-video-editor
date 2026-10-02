export type SourceCrop = { x: number; y: number; width: number; height: number };
export const FULL_CROP: SourceCrop = { x: 0, y: 0, width: 1, height: 1 };
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
export function normalizeCrop(raw: unknown): SourceCrop {
  const value = raw && typeof raw === "object" ? raw as Partial<SourceCrop> : {};
  const number = (v: unknown, fallback: number) => typeof v === "number" && Number.isFinite(v) ? v : fallback;
  const x = clamp(number(value.x, 0), 0, 0.99), y = clamp(number(value.y, 0), 0, 0.99);
  return { x, y, width: clamp(number(value.width, 1), 0.01, 1 - x), height: clamp(number(value.height, 1), 0.01, 1 - y) };
}
export function cropToAspect(crop: SourceCrop, ratio: number, sourceRatio: number): SourceCrop {
  const relative = ratio / sourceRatio;
  let width = crop.width, height = width / relative;
  if (height > crop.height) { height = crop.height; width = height * relative; }
  return normalizeCrop({ x: crop.x + (crop.width - width) / 2, y: crop.y + (crop.height - height) / 2, width, height });
}
export function dragCrop(original: SourceCrop, mode: "move" | "nw" | "ne" | "sw" | "se", dx: number, dy: number, relativeRatio?: number): SourceCrop {
  if (mode === "move") return { ...original, x: clamp(original.x + dx, 0, 1 - original.width), y: clamp(original.y + dy, 0, 1 - original.height) };
  const west = mode.includes("w"), north = mode.includes("n");
  const anchorX = west ? original.x + original.width : original.x;
  const anchorY = north ? original.y + original.height : original.y;
  const maxWidth = west ? anchorX : 1 - anchorX, maxHeight = north ? anchorY : 1 - anchorY;
  let width = clamp(original.width + (west ? -dx : dx), 0.01, maxWidth);
  let height = clamp(original.height + (north ? -dy : dy), 0.01, maxHeight);
  if (relativeRatio && Number.isFinite(relativeRatio)) {
    if (Math.abs(dx) >= Math.abs(dy * relativeRatio)) height = width / relativeRatio;
    else width = height * relativeRatio;
    const scale = Math.min(1, maxWidth / width, maxHeight / height);
    width *= scale; height *= scale;
    // Respect the minimum area while keeping the selected aspect ratio.
    const minimum = Math.max(0.01 / width, 0.01 / height, 1);
    const grow = Math.min(minimum, maxWidth / width, maxHeight / height);
    width *= grow; height *= grow;
  }
  return { x: west ? anchorX - width : anchorX, y: north ? anchorY - height : anchorY, width, height };
}
