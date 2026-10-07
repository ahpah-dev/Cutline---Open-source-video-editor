import type { EffectName } from "./model";

/** The same deterministic raster path is used in live preview and video export. */
export const EXPANDED_EFFECTS = [
  "Soft focus", "Directional blur", "Zoom blur", "Radial blur", "Tilt shift",
  "Light leak", "Film dust", "Film scratches", "Flicker", "Strobe",
  "Posterize", "Negative", "Solarize", "Halftone", "Edge glow", "Sketch",
  "Fisheye", "Swirl", "Ripple", "Kaleidoscope", "Mirror",
] as const satisfies readonly EffectName[];

type Region = { x: number; y: number; width: number; height: number };
const TAU = Math.PI * 2;
const bounded = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
const luminance = (data: Uint8ClampedArray, i: number) => data[i] * .2126 + data[i + 1] * .7152 + data[i + 2] * .0722;
const randomSequence = (seed: number) => () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
  return (seed >>> 0) / 4294967296;
};

/** Alpha-aware bilinear resampling prevents dark fringes on text and transparent PNGs. */
function sample(data: Uint8ClampedArray, width: number, height: number, x: number, y: number, result: number[]) {
  if (x < 0 || x > width - 1 || y < 0 || y > height - 1) {
    result.fill(0); return;
  }
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1);
  const dx = x - x0, dy = y - y0;
  const i0 = (y0 * width + x0) * 4, i1 = (y0 * width + x1) * 4;
  const i2 = (y1 * width + x0) * 4, i3 = (y1 * width + x1) * 4;
  const a0 = data[i0 + 3] / 255 * (1 - dx) * (1 - dy), a1 = data[i1 + 3] / 255 * dx * (1 - dy);
  const a2 = data[i2 + 3] / 255 * (1 - dx) * dy, a3 = data[i3 + 3] / 255 * dx * dy;
  result[3] = a0 + a1 + a2 + a3;
  for (let c = 0; c < 3; c++) result[c] = data[i0 + c] * a0 + data[i1 + c] * a1 + data[i2 + c] * a2 + data[i3 + c] * a3;
  if (result[3] > 0) {
    result[0] /= result[3]; result[1] /= result[3]; result[2] /= result[3];
  }
  result[3] *= 255;
}

function mixSample(data: Uint8ClampedArray, i: number, sampled: number[], amount: number, out: Uint8ClampedArray) {
  const oldAlpha = data[i + 3] / 255 * (1 - amount), newAlpha = sampled[3] / 255 * amount;
  const alpha = oldAlpha + newAlpha;
  for (let c = 0; c < 3; c++) out[i + c] = alpha ? (data[i + c] * oldAlpha + sampled[c] * newAlpha) / alpha : 0;
  out[i + 3] = alpha * 255;
}

function rasterEffect(
  ctx: CanvasRenderingContext2D, source: HTMLCanvasElement, scratch: HTMLCanvasElement,
  width: number, height: number, name: EffectName, amount: number, time: number, region: Region,
) {
  // Expensive remaps and edge filters never read back a 4K-sized pixel buffer.
  const scale = Math.min(1, 1024 / Math.max(width, height));
  const sw = Math.max(1, Math.round(width * scale)), sh = Math.max(1, Math.round(height * scale));
  if (scratch.width !== sw) scratch.width = sw;
  if (scratch.height !== sh) scratch.height = sh;
  const sc = scratch.getContext("2d", { willReadFrequently: true })!;
  sc.clearRect(0, 0, sw, sh);
  sc.drawImage(source, 0, 0, sw, sh);
  const original = sc.getImageData(0, 0, sw, sh), data = original.data;
  const output = sc.createImageData(sw, sh), out = output.data;
  const cx = (region.x + region.width / 2) * scale, cy = (region.y + region.height / 2) * scale;
  const rx = Math.max(1, region.width * scale / 2), ry = Math.max(1, region.height * scale / 2);
  const levels = Math.max(2, Math.round(12 - amount * 10));
  const dotSize = Math.max(3, Math.round(Math.min(sw, sh) / 40));
  const sampled = [0, 0, 0, 0];
  const remap = ["Fisheye", "Swirl", "Ripple", "Kaleidoscope", "Mirror"].includes(name);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    const i = (y * sw + x) * 4;
    if (remap) {
      const nx = (x - cx) / rx, ny = (y - cy) / ry, radius = Math.hypot(nx, ny);
      let sx = x, sy = y, blend = 1;
      if (name === "Mirror") { sx = cx - Math.abs(x - cx); blend = amount; }
      else if (name === "Kaleidoscope") {
        const sector = TAU / 6;
        let angle = (Math.atan2(ny, nx) + TAU) % sector;
        angle = Math.min(angle, sector - angle);
        sx = cx + Math.cos(angle) * radius * rx;
        sy = cy + Math.sin(angle) * radius * ry;
        blend = amount;
      } else if (radius > 0 && radius < 1) {
        if (name === "Fisheye") {
          const warped = Math.pow(radius, 1 + amount * .9);
          sx = cx + nx * warped / radius * rx; sy = cy + ny * warped / radius * ry;
        } else if (name === "Swirl") {
          const angle = Math.atan2(ny, nx) + amount * 3 * (1 - radius) ** 2;
          sx = cx + Math.cos(angle) * radius * rx; sy = cy + Math.sin(angle) * radius * ry;
        } else {
          const warped = radius + Math.sin(radius * 22 - time * 4) * amount * .055 * (1 - radius);
          sx = cx + nx * warped / radius * rx; sy = cy + ny * warped / radius * ry;
        }
      }
      sample(data, sw, sh, sx, sy, sampled);
      mixSample(data, i, sampled, blend, out);
      continue;
    }
    out[i + 3] = data[i + 3];
    if (!data[i + 3]) continue;
    let edge = 0;
    if (name === "Edge glow" || name === "Sketch") {
      const left = (y * sw + Math.max(0, x - 1)) * 4, right = (y * sw + Math.min(sw - 1, x + 1)) * 4;
      const top = (Math.max(0, y - 1) * sw + x) * 4, bottom = (Math.min(sh - 1, y + 1) * sw + x) * 4;
      // Include alpha edges so solid-color lettering still creates an outline.
      edge = bounded(Math.hypot(luminance(data, right) - luminance(data, left), luminance(data, bottom) - luminance(data, top))
        + Math.hypot(data[right + 3] - data[left + 3], data[bottom + 3] - data[top + 3]), 0, 255);
    }
    const gray = luminance(data, i);
    for (let c = 0; c < 3; c++) {
      let target = data[i + c];
      switch (name) {
        case "Posterize": target = Math.round(target / 255 * (levels - 1)) / (levels - 1) * 255; break;
        case "Negative": target = 255 - target; break;
        case "Solarize": target = target > 128 ? 255 - target : target; break;
        case "Halftone": {
          const dx = ((x + .5) % dotSize) / dotSize - .5, dy = ((y + .5) % dotSize) / dotSize - .5;
          const inkRadius = Math.sqrt(1 - gray / 255) * .7;
          target = Math.hypot(dx, dy) < inkRadius ? 20 : 242;
          break;
        }
        case "Edge glow": target = data[i + c] * .18 + edge * [0.25, .85, 1][c]; break;
        case "Sketch": target = bounded(246 - edge * 2.2 + (gray - 128) * .05, 10, 255); break;
      }
      out[i + c] = data[i + c] * (1 - amount) + target * amount;
    }
  }
  sc.putImageData(output, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(scratch, 0, 0, width, height);
}

/** Source is a snapshot, scratch is a reusable renderer-owned surface. Returns false for legacy effects. */
export function applyExpandedEffect(
  ctx: CanvasRenderingContext2D, source: HTMLCanvasElement, scratch: HTMLCanvasElement,
  width: number, height: number, name: EffectName, rawAmount: number, time: number, region: Region,
) {
  if (!(EXPANDED_EFFECTS as readonly string[]).includes(name)) return false;
  const amount = Number.isFinite(rawAmount) ? bounded(rawAmount, 0, 1) : 0;
  if (!amount) return true;
  ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1; ctx.filter = "none";
  const cx = region.x + region.width / 2, cy = region.y + region.height / 2;
  switch (name) {
    case "Soft focus":
      ctx.clearRect(0, 0, width, height);
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = 1 - amount * .6; ctx.drawImage(source, 0, 0);
      ctx.filter = `blur(${Math.max(.5, width / 95 * amount)}px) brightness(1.12)`;
      ctx.globalAlpha = amount * .6; ctx.drawImage(source, 0, 0); break;
    case "Directional blur":
    case "Zoom blur":
    case "Radial blur": {
      ctx.clearRect(0, 0, width, height);
      const passes = 11;
      ctx.globalAlpha = 1 / passes; ctx.globalCompositeOperation = "lighter";
      for (let n = 0; n < passes; n++) {
        const step = n / (passes - 1) - .5;
        ctx.save(); ctx.translate(cx, cy);
        if (name === "Directional blur") ctx.translate(step * region.width * .09 * amount, 0);
        if (name === "Zoom blur") { const scale = 1 + step * .28 * amount; ctx.scale(scale, scale); }
        if (name === "Radial blur") ctx.rotate(step * .24 * amount);
        ctx.drawImage(source, -cx, -cy); ctx.restore();
      }
      break;
    }
    case "Tilt shift": {
      if (scratch.width !== width) scratch.width = width;
      if (scratch.height !== height) scratch.height = height;
      const sc = scratch.getContext("2d")!;
      sc.clearRect(0, 0, width, height);
      sc.filter = `blur(${Math.max(.5, width / 70 * amount)}px)`;
      sc.drawImage(source, 0, 0); sc.filter = "none";
      const focus = sc.createLinearGradient(0, region.y, 0, region.y + region.height);
      focus.addColorStop(0, "white"); focus.addColorStop(.35, "transparent");
      focus.addColorStop(.65, "transparent"); focus.addColorStop(1, "white");
      sc.globalCompositeOperation = "destination-in"; sc.fillStyle = focus; sc.fillRect(0, 0, width, height);
      sc.globalCompositeOperation = "source-over";
      ctx.globalCompositeOperation = "destination-out"; ctx.fillStyle = focus; ctx.fillRect(0, 0, width, height);
      ctx.globalCompositeOperation = "lighter"; ctx.drawImage(scratch, 0, 0); break;
    }
    case "Light leak": {
      ctx.globalCompositeOperation = "source-atop";
      const x = region.x + region.width * (.08 + .12 * Math.sin(time * .7));
      const g = ctx.createRadialGradient(x, cy, 0, x, cy, Math.max(1, region.width * .8));
      g.addColorStop(0, `rgba(255,190,105,${amount * .75})`);
      g.addColorStop(.4, `rgba(255,69,106,${amount * .35})`); g.addColorStop(1, "transparent");
      ctx.fillStyle = g; ctx.fillRect(0, 0, width, height); break;
    }
    case "Film dust":
    case "Film scratches": {
      const random = randomSequence(Math.floor(time * 12) + 8919);
      ctx.globalCompositeOperation = "source-atop";
      if (name === "Film dust") {
        for (let n = 0; n < 180; n++) {
          const x = region.x + random() * region.width, y = region.y + random() * region.height;
          const size = Math.max(.7, Math.min(region.width, region.height) / 280 * (.5 + random() * 2));
          ctx.globalAlpha = amount * (.12 + random() * .6); ctx.fillStyle = random() > .45 ? "#f6e8d0" : "#161014";
          ctx.beginPath(); ctx.ellipse(x, y, size, size * .5, random() * TAU, 0, TAU); ctx.fill();
        }
      } else {
        ctx.strokeStyle = "#eadbc2"; ctx.lineWidth = Math.max(.5, width / 1800);
        for (let n = 0; n < 9; n++) {
          const x = region.x + random() * region.width, y = region.y + random() * region.height;
          ctx.globalAlpha = amount * (.12 + random() * .45);
          ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + region.width * .003 * Math.sin(time + n), y + region.height * (.15 + random() * .7)); ctx.stroke();
        }
      }
      break;
    }
    case "Flicker":
    case "Strobe": {
      const exposure = name === "Strobe" ? (Math.floor(time * 8) % 2 ? .8 : -.75)
        : Math.sin(time * 23 + .6) * .32 + Math.sin(time * 51 + .3) * .12;
      ctx.globalCompositeOperation = "source-atop"; ctx.globalAlpha = Math.abs(exposure) * amount;
      ctx.fillStyle = exposure > 0 ? "white" : "black"; ctx.fillRect(0, 0, width, height); break;
    }
    default: rasterEffect(ctx, source, scratch, width, height, name, amount, time, region);
  }
  return true;
}
