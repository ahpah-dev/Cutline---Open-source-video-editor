/** Canvas compositing controls. Positions and sizes use fractions, not pixels. */
export const MASK_SHAPES = ["None", "Rectangle", "Ellipse", "Linear", "Mirror", "Heart", "Star"] as const;
export type MaskShape = (typeof MASK_SHAPES)[number];
export const BLEND_MODES = ["Normal", "Multiply", "Screen", "Overlay", "Darken", "Lighten", "Color dodge", "Color burn", "Hard light", "Soft light", "Difference", "Exclusion", "Hue", "Saturation", "Color", "Luminosity", "Add"] as const;
export type BlendMode = (typeof BLEND_MODES)[number];
export type VisualCompositing = {
  maskShape?: MaskShape;
  /** Content follows the item's bounds and transform; canvas stays fixed in the output frame. */
  maskSpace?: "content" | "canvas";
  maskX?: number; maskY?: number; maskWidth?: number; maskHeight?: number;
  maskRotation?: number; maskFeather?: number; maskInvert?: boolean;
  blendMode?: BlendMode;
  chromaKey?: boolean; chromaColor?: string;
  chromaTolerance?: number; chromaSoftness?: number; chromaSpill?: number;
};
export const DEFAULT_COMPOSITING = {
  maskShape: "None" as MaskShape, maskSpace: "content" as const,
  maskX: 0.5, maskY: 0.5, maskWidth: 1, maskHeight: 1,
  maskRotation: 0, maskFeather: 0, maskInvert: false,
  blendMode: "Normal" as BlendMode,
  chromaKey: false, chromaColor: "#00ff00", chromaTolerance: 0.2,
  chromaSoftness: 0.08, chromaSpill: 0.5,
};
const finite = (value: unknown, fallback: number, lo: number, hi: number) =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(lo, Math.min(value, hi)) : fallback;
export function normalizeCompositing(raw: VisualCompositing): Required<VisualCompositing> {
  const d = DEFAULT_COMPOSITING;
  return {
    maskShape: MASK_SHAPES.includes(raw.maskShape as MaskShape) ? raw.maskShape! : d.maskShape,
    maskSpace: raw.maskSpace === "canvas" ? "canvas" : "content",
    maskX: finite(raw.maskX, d.maskX, -2, 3), maskY: finite(raw.maskY, d.maskY, -2, 3),
    maskWidth: finite(raw.maskWidth, d.maskWidth, 0.01, 3), maskHeight: finite(raw.maskHeight, d.maskHeight, 0.01, 3),
    maskRotation: finite(raw.maskRotation, d.maskRotation, -3600, 3600),
    maskFeather: finite(raw.maskFeather, d.maskFeather, 0, 0.5), maskInvert: raw.maskInvert === true,
    blendMode: BLEND_MODES.includes(raw.blendMode as BlendMode) ? raw.blendMode! : d.blendMode,
    chromaKey: raw.chromaKey === true,
    chromaColor: typeof raw.chromaColor === "string" && /^#[0-9a-f]{6}$/i.test(raw.chromaColor) ? raw.chromaColor : d.chromaColor,
    chromaTolerance: finite(raw.chromaTolerance, d.chromaTolerance, 0, 1),
    chromaSoftness: finite(raw.chromaSoftness, d.chromaSoftness, 0, 1),
    chromaSpill: finite(raw.chromaSpill, d.chromaSpill, 0, 1),
  };
}
export function canvasBlendMode(mode?: BlendMode): GlobalCompositeOperation {
  if (mode === "Add") return "lighter";
  if (!mode || mode === "Normal" || !BLEND_MODES.includes(mode)) return "source-over";
  return mode.toLowerCase().replaceAll(" ", "-") as GlobalCompositeOperation;
}
export type MaskFrame = { x: number; y: number; width: number; height: number; rotation: number; flipX?: boolean; flipY?: boolean };
export type MaskGeometry = {
  shape: MaskShape; x: number; y: number; width: number; height: number;
  rotation: number; feather: number; invert: boolean; flipX: boolean; flipY: boolean;
};
export function maskGeometry(item: VisualCompositing, content: MaskFrame, w: number, h: number): MaskGeometry {
  const mask = normalizeCompositing(item);
  const frame: MaskFrame = mask.maskSpace === "canvas" ? { x: w / 2, y: h / 2, width: w, height: h, rotation: 0 } : content;
  const fx = frame.flipX ? -1 : 1, fy = frame.flipY ? -1 : 1;
  const dx = (mask.maskX - 0.5) * frame.width * fx, dy = (mask.maskY - 0.5) * frame.height * fy;
  const angle = frame.rotation * Math.PI / 180;
  return {
    shape: mask.maskShape,
    x: frame.x + Math.cos(angle) * dx - Math.sin(angle) * dy,
    y: frame.y + Math.sin(angle) * dx + Math.cos(angle) * dy,
    width: Math.abs(frame.width * mask.maskWidth), height: Math.abs(frame.height * mask.maskHeight),
    rotation: frame.rotation + mask.maskRotation * fx * fy,
    feather: Math.min(Math.abs(frame.width), Math.abs(frame.height)) * mask.maskFeather,
    invert: mask.maskInvert, flipX: fx < 0, flipY: fy < 0,
  };
}
/** Closed unit-square paths used by both raster masks and SVG player guides. */
export function maskSvgPath(shape: MaskShape): string {
  switch (shape) {
    case "Ellipse": return "M 1 .5 A .5 .5 0 1 0 0 .5 A .5 .5 0 1 0 1 .5 Z";
    case "Heart": return "M .5 .94 C .4 .83 .04 .58 .04 .28 C .04 .04 .34 -.04 .5 .21 C .66 -.04 .96 .04 .96 .28 C .96 .58 .6 .83 .5 .94 Z";
    case "Star": {
      const points = Array.from({ length: 10 }, (_, i) => {
        const angle = -Math.PI / 2 + i * Math.PI / 5, radius = i % 2 ? 0.21 : 0.5;
        return `${i ? "L" : "M"} ${0.5 + Math.cos(angle) * radius} ${0.5 + Math.sin(angle) * radius}`;
      });
      return points.join(" ") + " Z";
    }
    default: return "M 0 0 H 1 V 1 H 0 Z";
  }
}
/** Draw the opaque side of a mask in output pixels. Linear and mirror extend across the entire frame. */
export function drawMaskPath(ctx: CanvasRenderingContext2D, mask: MaskGeometry, w: number, h: number) {
  ctx.save();
  ctx.translate(mask.x, mask.y);
  ctx.rotate(mask.rotation * Math.PI / 180);
  ctx.scale(mask.flipX ? -1 : 1, mask.flipY ? -1 : 1);
  if (mask.shape === "Linear" || mask.shape === "Mirror") {
    const reach = Math.hypot(w, h) * 8 + Math.hypot(mask.x, mask.y);
    ctx.fillRect(-reach, mask.shape === "Linear" ? 0 : -mask.height / 2, reach * 2, mask.shape === "Linear" ? reach : mask.height);
  } else {
    ctx.scale(mask.width, mask.height);
    ctx.translate(-0.5, -0.5);
    ctx.fill(new Path2D(maskSvgPath(mask.shape)));
  }
  ctx.restore();
}
export function chromaColorRgb(hex: string): [number, number, number] {
  return [Number.parseInt(hex.slice(1, 3), 16), Number.parseInt(hex.slice(3, 5), 16), Number.parseInt(hex.slice(5, 7), 16)];
}
/** RGB distance preserves white/black foregrounds; softness controls a smooth alpha edge. */
export function chromaAlpha(distance: number, tolerance: number, softness: number) {
  if (softness <= 0.00001) return distance > tolerance ? 1 : 0;
  const p = Math.max(0, Math.min((distance - tolerance) / softness, 1));
  return p * p * (3 - 2 * p);
}
/** Deterministic CPU fallback for devices without WebGL. Mutates unpremultiplied ImageData RGBA. */
export function keyChromaPixels(pixels: Uint8ClampedArray, settings: VisualCompositing) {
  const c = normalizeCompositing(settings);
  if (!c.chromaKey) return;
  const key = chromaColorRgb(c.chromaColor), max = Math.max(...key);
  const dominant = key.indexOf(max), otherA = (dominant + 1) % 3, otherB = (dominant + 2) % 3;
  const coloredKey = max - Math.min(...key) > 32;
  for (let i = 0; i < pixels.length; i += 4) {
    if (!pixels[i + 3]) continue;
    const distance = Math.hypot(pixels[i] - key[0], pixels[i + 1] - key[1], pixels[i + 2] - key[2]) / 441.67295593;
    const alpha = chromaAlpha(distance, c.chromaTolerance, c.chromaSoftness);
    pixels[i + 3] = Math.round(pixels[i + 3] * alpha);
    if (coloredKey && alpha > 0 && alpha < 1 && c.chromaSpill > 0) {
      const excess = Math.max(0, pixels[i + dominant] - Math.max(pixels[i + otherA], pixels[i + otherB]));
      pixels[i + dominant] -= excess * c.chromaSpill * (1 - alpha);
    }
  }
}
