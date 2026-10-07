import type { TransitionName } from "./model";

type Side = "out" | "in";
type Point = { x: number; y: number };

const smooth = (value: number) => value * value * (3 - 2 * value);
const centered = (ctx: CanvasRenderingContext2D, w: number, h: number, sx: number, sy = sx, rotation = 0) => {
  ctx.translate(w / 2, h / 2);
  if (rotation) ctx.rotate(rotation);
  ctx.scale(sx, sy);
  ctx.translate(-w / 2, -h / 2);
};

/** Clip a convex polygon against a half-plane, using a bounded number of vertices. */
function halfPlane(points: Point[], nx: number, ny: number, boundary: number): Point[] {
  const output: Point[] = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    const da = a.x * nx + a.y * ny - boundary, db = b.x * nx + b.y * ny - boundary;
    if (da <= 0) output.push(a);
    if ((da <= 0) !== (db <= 0)) {
      const ratio = da / (da - db);
      output.push({ x: a.x + (b.x - a.x) * ratio, y: a.y + (b.y - a.y) * ratio });
    }
  }
  return output;
}

function polygon(ctx: CanvasRenderingContext2D, points: Point[]) {
  if (!points.length) return;
  ctx.moveTo(points[0].x, points[0].y);
  for (const point of points.slice(1)) ctx.lineTo(point.x, point.y);
  ctx.closePath();
}

function rectangle(w: number, h: number, padding = 0): Point[] {
  return [{ x: -padding, y: -padding }, { x: w + padding, y: -padding }, { x: w + padding, y: h + padding }, { x: -padding, y: h + padding }];
}

/** Complementary clips share the same path, including antialiased boundary coverage. */
function reveal(ctx: CanvasRenderingContext2D, side: Side, w: number, h: number, path: () => void, inverse = false) {
  const complement = (side === "out") !== inverse;
  ctx.beginPath();
  if (complement) ctx.rect(0, 0, w, h);
  path();
  ctx.clip(complement ? "evenodd" : "nonzero");
}

/**
 * A transition is applied independently to the fully rendered outgoing and incoming layers.
 * This changes only Canvas state: no source reads, no frame-sized pixel loops or extra rasters.
 * The caller saves/restores the context around the layer draw. The same state also creates
 * blend coverage, keeping transparent masks and stationary lower layers correct.
 */
export function applyTransition(
  ctx: CanvasRenderingContext2D, name: TransitionName | string, progress: number, side: Side, w: number, h: number,
) {
  const p = Math.min(1, Math.max(0, Number.isFinite(progress) ? progress : 0));
  // Exact endpoints avoid residual zoom, blur, geometry and a one-frame color flash.
  if (p <= 0 || p >= 1) {
    ctx.globalAlpha = side === (p <= 0 ? "out" : "in") ? 1 : 0;
    return;
  }
  const e = smooth(p), outgoing = side === "out";
  const weight = outgoing ? 1 - e : e;
  const crossfade = () => { ctx.globalAlpha = weight; };
  // Add premultiplied sides, rather than layering two partially opaque dissolves.
  // Complementary reveal edges sum to complete coverage instead of forming dark seams.
  ctx.globalCompositeOperation = "lighter";
  switch (name) {
    case "None": ctx.globalAlpha = side === (p < .5 ? "out" : "in") ? 1 : 0; break;
    case "Dissolve": crossfade(); break;
    case "Fade black":
    case "Fade white": {
      const phase = outgoing ? Math.max(0, 1 - p * 2) : Math.max(0, p * 2 - 1);
      ctx.globalAlpha = smooth(phase);
      ctx.globalCompositeOperation = "source-over";
      break;
    }
    case "Wipe left":
    case "Wipe right":
    case "Wipe up":
    case "Wipe down": {
      const horizontal = name === "Wipe left" || name === "Wipe right";
      const reverse = name === "Wipe left" || name === "Wipe up";
      reveal(ctx, side, w, h, () => ctx.rect(
        horizontal && reverse ? w * (1 - e) : 0,
        !horizontal && reverse ? h * (1 - e) : 0,
        horizontal ? w * e : w, horizontal ? h : h * e,
      ));
      break;
    }
    case "Diagonal top left":
    case "Diagonal top right":
    case "Diagonal bottom left":
    case "Diagonal bottom right": {
      const nx = name.endsWith("right") ? -1 : 1, ny = name.includes("bottom") ? -1 : 1;
      const low = Math.min(0, nx * w) + Math.min(0, ny * h);
      const high = Math.max(0, nx * w) + Math.max(0, ny * h);
      const boundary = Math.round(low + (high - low) * e);
      ctx.beginPath();
      polygon(ctx, halfPlane(rectangle(w, h, 2), outgoing ? -nx : nx, outgoing ? -ny : ny, outgoing ? -boundary : boundary));
      ctx.clip();
      break;
    }
    case "Slide left":
    case "Slide right":
    case "Slide up":
    case "Slide down":
    case "Whip left":
    case "Whip right":
    case "Whip up":
    case "Whip down": {
      const horizontal = name.endsWith("left") || name.endsWith("right");
      const sign = name.endsWith("left") || name.endsWith("up") ? -1 : 1;
      const phase = outgoing ? e : e - 1;
      ctx.translate(horizontal ? sign * phase * w : 0, horizontal ? 0 : sign * phase * h);
      if (name.startsWith("Whip")) ctx.filter = `blur(${Math.sin(p * Math.PI) ** 2 * Math.min(24, w / 75)}px)`;
      break;
    }
    case "Push up left":
    case "Push up right": {
      const right = name === "Push up right";
      // Corner-anchored zooms keep each translating frame covering the full crop,
      // instead of leaving black triangular gaps during a diagonal push.
      const phase = outgoing ? e : 1 - e, direction = outgoing ? 1 : -1;
      crossfade();
      ctx.translate((right ? 1 : -1) * direction * phase * w, -direction * phase * h);
      centered(ctx, w, h, 1 + phase * 2);
      break;
    }
    case "Zoom":
      crossfade(); centered(ctx, w, h, outgoing ? 1 + e * .18 : .65 + e * .35); break;
    case "Zoom out":
      crossfade(); centered(ctx, w, h, outgoing ? 1 - e * .35 : 1 + (1 - e) * .18); break;
    case "Cross zoom":
      crossfade(); centered(ctx, w, h, outgoing ? 1 + e * .85 : 1 + (1 - e) * .85);
      ctx.filter = `blur(${Math.sin(p * Math.PI) ** 2 * Math.min(12, w / 120)}px)`;
      break;
    case "Spin clockwise":
    case "Spin counterclockwise": {
      crossfade();
      const sign = name === "Spin clockwise" ? 1 : -1;
      const rotation = sign * (outgoing ? e : e - 1) * Math.PI / 2;
      // Scale up during the turn to keep the rotating frame's corners outside the crop.
      const cosine = Math.abs(Math.cos(rotation)), sine = Math.abs(Math.sin(rotation));
      const scale = Math.max(cosine + h / w * sine, cosine + w / h * sine);
      centered(ctx, w, h, scale, scale, rotation);
      break;
    }
    case "Flip horizontal":
    case "Flip vertical": {
      const cosine = Math.cos(p * Math.PI), visible = outgoing ? cosine > 0 : cosine < 0;
      ctx.globalAlpha = visible ? 1 : 0;
      const fold = Math.max(.00001, Math.abs(cosine));
      centered(ctx, w, h, name === "Flip horizontal" ? fold : 1, name === "Flip vertical" ? fold : 1);
      break;
    }
    case "Blur":
      crossfade(); ctx.filter = `blur(${(outgoing ? p : 1 - p) * Math.min(28, w / 70)}px)`; break;
    case "Circle":
    case "Iris close": {
      const close = name === "Iris close", radius = Math.hypot(w, h) / 2 * (close ? 1 - e : e);
      reveal(ctx, side, w, h, () => { ctx.moveTo(w / 2 + radius, h / 2); ctx.arc(w / 2, h / 2, radius, 0, Math.PI * 2); }, close);
      break;
    }
    case "Diamond": {
      const radius = (w + h) / 2 * e;
      reveal(ctx, side, w, h, () => polygon(ctx, [
        { x: w / 2, y: h / 2 - radius }, { x: w / 2 + radius, y: h / 2 },
        { x: w / 2, y: h / 2 + radius }, { x: w / 2 - radius, y: h / 2 },
      ]));
      break;
    }
    case "Heart": {
      const size = Math.hypot(w, h) * 1.6 * e, x = w / 2, y = h / 2;
      reveal(ctx, side, w, h, () => {
        ctx.moveTo(x, y + size * .55);
        ctx.bezierCurveTo(x - size * .15, y + size * .38, x - size * .8, y - size * .1, x - size * .45, y - size * .36);
        ctx.bezierCurveTo(x - size * .24, y - size * .57, x - size * .05, y - size * .5, x, y - size * .34);
        ctx.bezierCurveTo(x + size * .05, y - size * .5, x + size * .24, y - size * .57, x + size * .45, y - size * .36);
        ctx.bezierCurveTo(x + size * .8, y - size * .1, x + size * .15, y + size * .38, x, y + size * .55);
        ctx.closePath();
      });
      break;
    }
    case "Star": {
      const radius = Math.hypot(w, h) * 1.5 * e;
      reveal(ctx, side, w, h, () => polygon(ctx, Array.from({ length: 10 }, (_, i) => {
        const angle = -Math.PI / 2 + i * Math.PI / 5, r = radius * (i % 2 ? .42 : 1);
        return { x: w / 2 + Math.cos(angle) * r, y: h / 2 + Math.sin(angle) * r };
      })));
      break;
    }
    case "Clock clockwise":
    case "Clock counterclockwise": {
      const reverse = name === "Clock counterclockwise", radius = Math.hypot(w, h);
      const start = -Math.PI / 2, angle = start + (reverse ? -1 : 1) * e * Math.PI * 2;
      reveal(ctx, side, w, h, () => {
        ctx.moveTo(w / 2, h / 2); ctx.lineTo(w / 2, h / 2 - radius);
        ctx.arc(w / 2, h / 2, radius, start, angle, reverse); ctx.closePath();
      });
      break;
    }
    case "Split horizontal":
    case "Split vertical": {
      const horizontal = name === "Split horizontal";
      reveal(ctx, side, w, h, () => ctx.rect(horizontal ? 0 : w * (1 - e) / 2, horizontal ? h * (1 - e) / 2 : 0, horizontal ? w : w * e, horizontal ? h * e : h));
      break;
    }
    case "Blinds horizontal":
    case "Blinds vertical": {
      const horizontal = name === "Blinds horizontal", count = 8;
      reveal(ctx, side, w, h, () => {
        for (let i = 0; i < count; i++) ctx.rect(horizontal ? 0 : i * w / count, horizontal ? i * h / count : 0, horizontal ? w : w / count * e, horizontal ? h / count * e : h);
      });
      break;
    }
    case "Checkerboard": {
      const columns = 8, rows = 5;
      reveal(ctx, side, w, h, () => {
        for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
          const reveal = smooth(Math.min(1, Math.max(0, p * 1.45 - ((row + column) % 2) * .45)));
          const scale = Math.sqrt(reveal), tw = w / columns, th = h / rows;
          ctx.rect((column + (1 - scale) / 2) * tw, (row + (1 - scale) / 2) * th, tw * scale, th * scale);
        }
      });
      break;
    }
    case "Diagonal stripes": {
      const period = (w + h) / 12;
      reveal(ctx, side, w, h, () => {
        for (let i = 0; i < 12; i++) polygon(ctx, halfPlane(halfPlane(rectangle(w, h), 1, 1, (i + e) * period), -1, -1, -i * period));
      });
      break;
    }
    case "Shutter": {
      reveal(ctx, side, w, h, () => {
        for (let row = 0; row < 8; row++) {
          const center = .5 + (row % 2 ? .25 : -.25) * (1 - e);
          ctx.rect((center - e / 2) * w, row * h / 8, e * w, h / 8);
        }
      });
      break;
    }
    case "Glitch": {
      crossfade();
      const envelope = Math.sin(p * Math.PI) ** 2;
      ctx.translate(Math.sin(p * 90) * w * .04 * envelope * (outgoing ? -1 : 1), 0);
      ctx.filter = `hue-rotate(${Math.sin(p * 30) * 90 * envelope * (outgoing ? -1 : 1)}deg)`;
      break;
    }
    default: crossfade();
  }
}
