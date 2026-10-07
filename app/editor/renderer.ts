import {
  clamp,
  animatedItem,
  clipDuration,
  endOf,
  interpolatedTransform,
  normalizeGradientStops,
  trackKey,
  transitionWindow,
  type Asset,
  type Clip,
  type Project,
  type TextClip,
} from "./model";
import { FILTERS } from "./presets";
import { letterPopProgress, textMotion } from "./textAnimation";
import { normalizeCrop } from "./crop";
import {
  canvasBlendMode, chromaColorRgb, drawMaskPath, keyChromaPixels, maskGeometry,
  normalizeCompositing, type BlendMode, type MaskFrame, type VisualCompositing,
} from "./visualCompositing";

export type MediaSources = Map<string, HTMLVideoElement | HTMLImageElement>;
export type Bounds = {
  id: string;
  kind: "clip" | "text";
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  flipX?: boolean;
  flipY?: boolean;
};
const rad = (degrees: number) => (degrees * Math.PI) / 180;
const surface = () => document.createElement("canvas");
const sourceSize = (source: HTMLVideoElement | HTMLImageElement | undefined, asset: Asset | undefined) => ({
  width: source instanceof HTMLVideoElement ? source.videoWidth : source?.naturalWidth || asset?.width || 0,
  height: source instanceof HTMLVideoElement ? source.videoHeight : source?.naturalHeight || asset?.height || 0,
});
export class Renderer {
  private layer = surface();
  private transitionLayer = surface();
  private transitionBackdrop = surface();
  private transitionSide = surface();
  private transitionCoverage = surface();
  private temp = surface();
  private pixel = surface();
  private maskSurface = surface();
  private maskBlurSurface = surface();
  private maskSignature = "";
  private chromaSource = surface();
  private chromaSurface = surface();
  private chromaFallback = surface();
  private chromaAttempted = false;
  private chromaState: {
    gl: WebGLRenderingContext; program: WebGLProgram; texture: WebGLTexture;
    buffer: WebGLBuffer; position: number;
    key: WebGLUniformLocation; tolerance: WebGLUniformLocation;
    softness: WebGLUniformLocation; spill: WebGLUniformLocation;
  } | null = null;
  private wavySurface = surface();
  private wavyFallbackSurface = surface();
  private wavyAttempted = false;
  private wavyState: {
    gl: WebGLRenderingContext;
    program: WebGLProgram;
    texture: WebGLTexture;
    buffer: WebGLBuffer;
    position: number;
    amplitude: WebGLUniformLocation;
    waves: WebGLUniformLocation;
    phase: WebGLUniformLocation;
  } | null = null;
  bounds: Bounds[] = [];

  /** Release GPU objects and raster backing stores when a player/export session closes. */
  dispose() {
    for (const state of [this.chromaState, this.wavyState]) {
      if (!state) continue;
      state.gl.deleteTexture(state.texture); state.gl.deleteBuffer(state.buffer); state.gl.deleteProgram(state.program);
      state.gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
    this.chromaState = null; this.wavyState = null;
    this.chromaAttempted = false; this.wavyAttempted = false; this.maskSignature = ""; this.bounds = [];
    for (const canvas of [this.layer, this.transitionLayer, this.transitionBackdrop, this.transitionSide, this.transitionCoverage,
      this.temp, this.pixel, this.maskSurface, this.maskBlurSurface, this.chromaSource, this.chromaSurface, this.chromaFallback,
      this.wavySurface, this.wavyFallbackSurface]) { canvas.width = 0; canvas.height = 0; }
  }

  draw(
    canvas: HTMLCanvasElement,
    project: Project,
    time: number,
    sources: MediaSources,
  ) {
    const ctx = canvas.getContext("2d")!;
    const w = canvas.width,
      h = canvas.height;
    this.bounds = [];
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = project.background;
    ctx.fillRect(0, 0, w, h);
    if (this.layer.width !== w || this.layer.height !== h) {
      this.layer.width = this.temp.width = w;
      this.layer.height = this.temp.height = h;
      this.transitionLayer.width = w;
      this.transitionLayer.height = h;
    }
    const visible = project.clips.filter(
      (c) => c.kind === "video" && !project.hiddenTracks.includes(trackKey(c)),
    );
    const joins = visible.flatMap((incoming) => {
      const window = transitionWindow(project, incoming);
      return window ? [{ incoming, window }] : [];
    });
    const activeVideos = [...new Set(visible.map((c) => c.track))].flatMap(
      (track) => {
        const joining = joins.filter(({ incoming, window }) => incoming.track === track && time >= window.start && time < window.end)
          .sort((a, b) => a.incoming.start - b.incoming.start).at(-1);
        if (joining) return [joining.incoming];
        const active = visible
          .filter(
            (c) => c.track === track && time >= c.start && time < endOf(c),
          )
          .sort((a, b) => a.start - b.start)
          .at(-1);
        return active ? [active] : [];
      },
    );
    // One compositing order for preview, hit testing, and exported frames.
    // Clip type never takes precedence over its layer.
    const visualItems = [
      ...activeVideos,
      ...project.texts.filter(
        (t) =>
          time >= t.start &&
          time < endOf(t) &&
          !project.hiddenTracks.includes(trackKey(t)),
      ),
    ].sort((a, b) => a.track - b.track || a.start - b.start);
    for (const active of visualItems) {
      if (!("assetId" in active)) {
        const textContext = this.layer.getContext("2d")!;
        textContext.clearRect(0, 0, w, h);
        const animated = animatedItem(active, time);
        this.drawText(textContext, animated, time, w, h);
        const bounds = this.bounds.at(-1);
        if (animated.chromaKey) {
          const keyed = this.renderChroma(this.layer, normalizeCompositing(animated), w, h);
          textContext.clearRect(0, 0, w, h); textContext.drawImage(keyed, 0, 0);
        }
        this.applyEffects(animated.effects ?? [], time, w, h, bounds);
        this.applyMask(animated, bounds ?? { x: w / 2, y: h / 2, width: w, height: h, rotation: 0 }, w, h);
        this.composite(ctx, this.layer, animated.blendMode);
        continue;
      }
      const join = joins.find(({ incoming, window }) => incoming.id === active.id && time >= window.start && time < window.end);
      if (join) {
        const pair = this.transitionLayer.getContext("2d")!;
        const progress = clamp((time - join.window.start) / join.window.duration, 0, 1);
        pair.clearRect(0, 0, w, h);
        const compositingTransition = [join.window.previous, active].some((clip) => canvasBlendMode(animatedItem(clip, time).blendMode) !== "source-over");
        if (active.transition === "Fade black" || active.transition === "Fade white") {
          pair.fillStyle = active.transition === "Fade black" ? "#000" : "#fff";
          pair.fillRect(0, 0, w, h);
        }
        if (compositingTransition) {
          for (const surface of [this.transitionBackdrop, this.transitionSide, this.transitionCoverage]) {
            if (surface.width !== w || surface.height !== h) { surface.width = w; surface.height = h; }
          }
          const backdrop = this.transitionBackdrop.getContext("2d")!;
          backdrop.clearRect(0, 0, w, h); backdrop.drawImage(canvas, 0, 0);
        }
        for (const [clip, side] of [[join.window.previous, "out"], [active, "in"]] as const) {
          this.drawClip(project.assets.find((a) => a.id === clip.assetId), clip, time, sources.get(clip.id), w, h, true);
          if (compositingTransition) {
            this.blendedTransitionSide(pair, active.transition, progress, side, animatedItem(clip, time).blendMode, w, h);
            continue;
          }
          pair.save();
          this.transition(pair, active.transition, progress, side, w, h);
          pair.drawImage(this.layer, 0, 0);
          pair.restore();
        }
        this.composite(ctx, this.transitionLayer);
      } else {
        this.drawClip(project.assets.find((a) => a.id === active.assetId), active, time, sources.get(active.id), w, h);
        this.composite(ctx, this.layer, animatedItem(active, time).blendMode);
      }
      const hitClip = animatedItem(join && time < active.start ? join.window.previous : active, time);
      const tr = interpolatedTransform(hitClip, time - hitClip.start);
      const motion = this.clipMotion(hitClip, time, !!join);
      const shake = (hitClip.effects.find((effect) => effect.name === "Shake")?.amount ?? 0) / 100;
      const pulse = (hitClip.effects.find((effect) => effect.name === "Pulse")?.amount ?? 0) / 100;
      const pulseScale = 1 + pulse * 0.05 * (1 + Math.sin(time * Math.PI * 3));
      const asset = project.assets.find((a) => a.id === hitClip.assetId);
      const size = sourceSize(sources.get(hitClip.id), asset);
      const crop = normalizeCrop(hitClip.crop);
      size.width *= crop.width; size.height *= crop.height;
      const fittedScale = size.width && size.height ? Math.min(w / size.width, h / size.height) : 0;
      const contentWidth = hitClip.fit === "contain" && fittedScale ? size.width * fittedScale : w;
      const contentHeight = hitClip.fit === "contain" && fittedScale ? size.height * fittedScale : h;
      this.bounds.push({
        id: hitClip.id,
        kind: "clip",
        x: w / 2 + (tr.x + motion.x) * w + Math.sin(time * 53) * w * 0.016 * shake,
        y: h / 2 + (tr.y + motion.y) * h + Math.cos(time * 47) * h * 0.018 * shake,
        width: Math.abs(contentWidth * tr.scale * pulseScale * motion.scaleX),
        height: Math.abs(contentHeight * tr.scale * pulseScale * motion.scaleY),
        rotation: tr.rotation + motion.rotation,
        flipX: hitClip.flipX !== (tr.scale * pulseScale * motion.scaleX < 0),
        flipY: hitClip.flipY !== (tr.scale * pulseScale * motion.scaleY < 0),
      });
    }
    return this.bounds;
  }

  private composite(ctx: CanvasRenderingContext2D, layer: HTMLCanvasElement, mode?: BlendMode) {
    ctx.save();
    ctx.globalCompositeOperation = canvasBlendMode(mode);
    ctx.drawImage(layer, 0, 0);
    ctx.restore();
  }

  /** Resolve each side's blend against the same fixed backdrop before weighting the transition.
   * Separate coverage keeps the backdrop stationary through slides, wipes and transparent masks. */
  private blendedTransitionSide(pair: CanvasRenderingContext2D, name: string, p: number, side: "out" | "in", blendMode: BlendMode | undefined, w: number, h: number) {
    const source = this.transitionSide.getContext("2d")!;
    source.clearRect(0, 0, w, h);
    source.save(); this.transition(source, name, p, side, w, h);
    source.globalAlpha = 1; source.globalCompositeOperation = "source-over";
    source.drawImage(this.layer, 0, 0); source.restore();
    const coverage = this.transitionCoverage.getContext("2d")!;
    coverage.clearRect(0, 0, w, h);
    coverage.save(); this.transition(coverage, name, p, side, w, h);
    coverage.globalCompositeOperation = "source-over"; coverage.fillStyle = "white";
    coverage.fillRect(0, 0, w, h); coverage.restore();
    // Effects have finished with the shared scratch canvas by this point.
    const resolved = this.temp.getContext("2d")!;
    resolved.clearRect(0, 0, w, h); resolved.drawImage(this.transitionBackdrop, 0, 0);
    this.composite(resolved, this.transitionSide, blendMode);
    resolved.save(); resolved.globalCompositeOperation = "destination-in"; resolved.drawImage(this.transitionCoverage, 0, 0); resolved.restore();
    pair.save();
    pair.globalCompositeOperation = name === "Fade black" || name === "Fade white" ? "source-over" : "lighter";
    pair.drawImage(this.temp, 0, 0); pair.restore();
  }

  private transition(
    ctx: CanvasRenderingContext2D,
    name: string,
    p: number,
    side: "out" | "in",
    w: number,
    h: number,
  ) {
    const ease = p * p * (3 - 2 * p);
    switch (name) {
      case "Dissolve":
        ctx.globalAlpha = side === "out" ? 1 - ease : ease;
        ctx.globalCompositeOperation = "lighter";
        break;
      case "Fade black":
      case "Fade white":
        ctx.globalAlpha = side === "out" ? Math.max(0, 1 - p * 2) : Math.max(0, p * 2 - 1);
        break;
      case "Wipe left":
        ctx.beginPath();
        ctx.rect(side === "in" ? w * (1 - ease) : 0, 0, w * (side === "in" ? ease : 1 - ease), h);
        ctx.clip();
        break;
      case "Wipe right":
        ctx.beginPath();
        ctx.rect(side === "in" ? 0 : w * ease, 0, w * (side === "in" ? ease : 1 - ease), h);
        ctx.clip();
        break;
      case "Wipe up":
        ctx.beginPath();
        ctx.rect(0, side === "in" ? h * (1 - ease) : 0, w, h * (side === "in" ? ease : 1 - ease));
        ctx.clip();
        break;
      case "Slide left":
        ctx.translate(side === "out" ? -ease * w : (1 - ease) * w, 0);
        break;
      case "Slide right":
        ctx.translate(side === "out" ? ease * w : -(1 - ease) * w, 0);
        break;
      case "Zoom": {
        const s = side === "out" ? 1 + ease * 0.18 : 0.65 + ease * 0.35;
        ctx.globalAlpha = side === "out" ? 1 - ease : ease;
        ctx.globalCompositeOperation = "lighter";
        ctx.translate(w / 2, h / 2);
        ctx.scale(s, s);
        ctx.translate(-w / 2, -h / 2);
        break;
      }
      case "Blur":
        ctx.globalAlpha = side === "out" ? 1 - ease : ease;
        ctx.globalCompositeOperation = "lighter";
        ctx.filter = "blur(" + ((side === "out" ? p : 1 - p) * w) / 70 + "px)";
        break;
      case "Circle":
        ctx.beginPath();
        if (side === "out") ctx.rect(0, 0, w, h);
        ctx.arc(w / 2, h / 2, (Math.hypot(w, h) / 2) * ease, 0, Math.PI * 2);
        ctx.clip(side === "out" ? "evenodd" : "nonzero");
        break;
      case "Glitch":
        ctx.globalAlpha = side === "out" ? 1 - ease : ease;
        ctx.globalCompositeOperation = "lighter";
        ctx.translate(Math.sin(p * 90) * w * 0.04 * (side === "out" ? -p : 1 - p), 0);
        ctx.filter = "hue-rotate(" + Math.sin(p * 30) * 90 * (side === "out" ? p : 1 - p) + "deg)";
        break;
    }
  }

  private clipMotion(c: Clip, time: number, supportFrame: boolean) {
    if (supportFrame && (time < c.start || time >= endOf(c))) {
      const still = { ...c, animation: "None" as const, exitAnimation: "None" as const, animationStack: [], exitAnimationStack: [] };
      return textMotion(still, clamp(time, c.start, endOf(c) - 0.0001), false);
    }
    return textMotion(c, time, false);
  }

  private drawClip(
    asset: Asset | undefined,
    c: Clip,
    time: number,
    source: HTMLVideoElement | HTMLImageElement | undefined,
    w: number,
    h: number,
    supportFrame = false,
  ) {
    c = animatedItem(c, time);
    const ctx = this.layer.getContext("2d")!;
    ctx.clearRect(0, 0, w, h);
    if (!asset) return;
    const tr = interpolatedTransform(c, time - c.start);
    const motion = this.clipMotion(c, time, supportFrame);
    const amount = (name: string) =>
      (c.effects.find((e) => e.name === name)?.amount ?? 0) / 100;
    ctx.save();
    const shake = amount("Shake"),
      pulse = amount("Pulse");
    ctx.translate(
      w / 2 + (tr.x + motion.x) * w + Math.sin(time * 53) * w * 0.016 * shake,
      h / 2 + (tr.y + motion.y) * h + Math.cos(time * 47) * h * 0.018 * shake,
    );
    ctx.rotate(rad(tr.rotation + motion.rotation));
    const zoom =
      tr.scale * (1 + pulse * 0.05 * (1 + Math.sin(time * Math.PI * 3)));
    const sourceDimensions = sourceSize(source, asset), sourceCrop = normalizeCrop(c.crop);
    const contentFit = sourceDimensions.width && sourceDimensions.height
      ? Math.min(w / (sourceDimensions.width * sourceCrop.width), h / (sourceDimensions.height * sourceCrop.height)) : 0;
    const contentFrame: MaskFrame = {
      x: w / 2 + (tr.x + motion.x) * w + Math.sin(time * 53) * w * 0.016 * shake,
      y: h / 2 + (tr.y + motion.y) * h + Math.cos(time * 47) * h * 0.018 * shake,
      width: Math.abs((c.fit === "contain" && contentFit ? sourceDimensions.width * sourceCrop.width * contentFit : w) * zoom * motion.scaleX),
      height: Math.abs((c.fit === "contain" && contentFit ? sourceDimensions.height * sourceCrop.height * contentFit : h) * zoom * motion.scaleY),
      rotation: tr.rotation + motion.rotation,
      flipX: c.flipX !== (zoom * motion.scaleX < 0), flipY: c.flipY !== (zoom * motion.scaleY < 0),
    };
    ctx.scale(zoom * motion.scaleX * (c.flipX ? -1 : 1), zoom * motion.scaleY * (c.flipY ? -1 : 1));
    ctx.translate(-w / 2, -h / 2);
    // Keep the visible crop inside the same frame used by selection handles.
    ctx.beginPath(); ctx.rect(0, 0, w, h); ctx.clip();
    ctx.globalAlpha = clamp(tr.opacity * motion.opacity, 0, 1);
    ctx.filter = [
      FILTERS.find((f) => f.name === c.filter)?.css,
      "brightness(" + c.brightness + "%)",
      "contrast(" + c.contrast + "%)",
      "saturate(" + c.saturation + "%)",
      amount("Blur") ? "blur(" + (amount("Blur") * w) / 55 + "px)" : "",
      motion.blur ? "blur(" + motion.blur * w + "px)" : "",
    ]
      .filter(Boolean)
      .join(" ");
    for (const { direction, amount: reveal } of motion.reveals) {
      let rx = 0, ry = 0, cw = w, ch = h;
      if (direction === "Wipe left") { cw *= reveal; rx += w - cw; }
      if (direction === "Wipe right") cw *= reveal;
      if (direction === "Wipe up") { ch *= reveal; ry += h - ch; }
      if (direction === "Wipe down") ch *= reveal;
      ctx.beginPath(); ctx.rect(rx, ry, cw, ch); ctx.clip();
    }
    if (motion.characters < 1) {
      ctx.beginPath(); ctx.rect(0, 0, w * motion.characters, h); ctx.clip();
    }
    const chroma = c.chromaKey ? normalizeCompositing(c) : null;
    let mediaContext = ctx;
    if (chroma) {
      if (this.chromaSource.width !== w || this.chromaSource.height !== h) { this.chromaSource.width = w; this.chromaSource.height = h; }
      mediaContext = this.chromaSource.getContext("2d")!;
      mediaContext.clearRect(0, 0, w, h);
    }
    if (asset.kind === "demo")
      drawDemo(mediaContext, asset, w, h, (time - c.start) / clipDuration(c));
    else if (source) {
      const { width: originalWidth, height: originalHeight } = sourceSize(source, asset);
      const crop = normalizeCrop(c.crop);
      const sw = originalWidth * crop.width, sh = originalHeight * crop.height;
      if (sw && sh) {
        const s =
          c.fit === "cover"
            ? Math.max(w / sw, h / sh)
            : Math.min(w / sw, h / sh);
        mediaContext.drawImage(
          source,
          originalWidth * crop.x, originalHeight * crop.y, sw, sh,
          (w - sw * s) / 2,
          (h - sh * s) / 2,
          sw * s,
          sh * s,
        );
      }
    }
    if (chroma) ctx.drawImage(this.renderChroma(this.chromaSource, chroma, w, h), 0, 0, w, h);
    ctx.restore();
    if (c.temperature) {
      ctx.save();
      ctx.globalCompositeOperation = "source-atop";
      ctx.fillStyle = c.temperature > 0 ? "#ff9900" : "#3388ff";
      ctx.globalAlpha = Math.abs(c.temperature) / 500;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    }
    this.applyEffects(c.effects, time, w, h);
    this.applyMask(c, contentFrame, w, h);
  }

  private applyMask(item: VisualCompositing, frame: MaskFrame, w: number, h: number) {
    if (!item.maskShape || item.maskShape === "None") return;
    const geometry = maskGeometry(item, frame, w, h);
    if (geometry.shape === "None") return;
    const signature = JSON.stringify([w, h, geometry]);
    // Blur outside the output frame as well, so the frame boundary never becomes a mask edge.
    // Large soft masks use a smaller raster; the visible feather stays measured in output pixels.
    const scale = geometry.feather > 0 ? Math.min(1, 256 / geometry.feather, 2048 / (Math.max(w, h) + geometry.feather * 6)) : 1;
    const padding = geometry.feather > 0 ? Math.ceil(geometry.feather * scale * 3) : 0;
    const width = Math.ceil(w * scale) + padding * 2, height = Math.ceil(h * scale) + padding * 2;
    if (this.maskSurface.width !== width || this.maskSurface.height !== height) {
      this.maskSurface.width = width;
      this.maskSurface.height = height;
      this.maskSignature = "";
    }
    const blurWidth = geometry.feather > 0 ? width : 0, blurHeight = geometry.feather > 0 ? height : 0;
    if (this.maskBlurSurface.width !== blurWidth || this.maskBlurSurface.height !== blurHeight) {
      this.maskBlurSurface.width = blurWidth; this.maskBlurSurface.height = blurHeight;
    }
    if (signature !== this.maskSignature) {
      const mask = this.maskSurface.getContext("2d")!;
      mask.clearRect(0, 0, width, height); mask.fillStyle = "white";
      mask.save(); mask.translate(padding, padding); mask.scale(scale, scale);
      drawMaskPath(mask, geometry, w, h); mask.restore();
      if (geometry.feather > 0) {
        const blur = this.maskBlurSurface.getContext("2d")!;
        blur.clearRect(0, 0, width, height);
        blur.save(); blur.filter = `blur(${geometry.feather * scale}px)`; blur.drawImage(this.maskSurface, 0, 0); blur.restore();
        mask.clearRect(0, 0, width, height); mask.drawImage(this.maskBlurSurface, 0, 0);
      }
      this.maskSignature = signature;
    }
    const ctx = this.layer.getContext("2d")!;
    ctx.save(); ctx.globalCompositeOperation = geometry.invert ? "destination-out" : "destination-in";
    ctx.drawImage(this.maskSurface, padding, padding, w * scale, h * scale, 0, 0, w, h); ctx.restore();
  }

  /** Chroma is keyed on original colors before grading, transform, effects and masking. */
  private renderChroma(source: HTMLCanvasElement, settings: Required<VisualCompositing>, w: number, h: number): HTMLCanvasElement {
    if (!this.chromaState && !this.chromaAttempted) { this.chromaAttempted = true; this.chromaState = this.createChromaRenderer(); }
    const state = this.chromaState;
    if (state && !state.gl.isContextLost()) {
      const { gl, program, texture, buffer, position, key, tolerance, softness, spill } = state;
      if (this.chromaSurface.width !== w || this.chromaSurface.height !== h) { this.chromaSurface.width = w; this.chromaSurface.height = h; }
      gl.viewport(0, 0, w, h); gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer); gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      const rgb = chromaColorRgb(settings.chromaColor);
      gl.uniform3f(key, rgb[0] / 255, rgb[1] / 255, rgb[2] / 255);
      gl.uniform1f(tolerance, settings.chromaTolerance); gl.uniform1f(softness, Math.max(0.00001, settings.chromaSoftness)); gl.uniform1f(spill, settings.chromaSpill);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      return this.chromaSurface;
    }
    if (this.chromaFallback.width !== w || this.chromaFallback.height !== h) { this.chromaFallback.width = w; this.chromaFallback.height = h; }
    const ctx = this.chromaFallback.getContext("2d", { willReadFrequently: true })!;
    ctx.clearRect(0, 0, w, h); ctx.drawImage(source, 0, 0);
    const image = ctx.getImageData(0, 0, w, h); keyChromaPixels(image.data, settings); ctx.putImageData(image, 0, 0);
    return this.chromaFallback;
  }

  private createChromaRenderer() {
    const gl = this.chromaSurface.getContext("webgl", { alpha: true, antialias: false, preserveDrawingBuffer: true, premultipliedAlpha: false });
    if (!gl) return null;
    const compile = (kind: number, source: string) => {
      const shader = gl.createShader(kind); if (!shader) return null;
      gl.shaderSource(shader, source); gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) { gl.deleteShader(shader); return null; }
      return shader;
    };
    const vertex = compile(gl.VERTEX_SHADER, "attribute vec2 a_position; varying vec2 v_uv; void main(){gl_Position=vec4(a_position,0.,1.);v_uv=a_position*.5+.5;}");
    const fragment = compile(gl.FRAGMENT_SHADER, `
      precision mediump float;
      varying vec2 v_uv; uniform sampler2D u_source; uniform vec3 u_key;
      uniform float u_tolerance; uniform float u_softness; uniform float u_spill;
      void main() {
        vec4 pixel = texture2D(u_source, v_uv);
        float distance = length(pixel.rgb - u_key) / 1.7320508;
        float alpha = smoothstep(u_tolerance, u_tolerance + u_softness, distance);
        float top = max(u_key.r, max(u_key.g, u_key.b));
        float bottom = min(u_key.r, min(u_key.g, u_key.b));
        if(top - bottom > .125 && alpha > 0. && alpha < 1.) {
          float strength = u_spill * (1. - alpha);
          if(u_key.r >= u_key.g && u_key.r >= u_key.b) pixel.r -= max(0., pixel.r - max(pixel.g, pixel.b)) * strength;
          else if(u_key.g >= u_key.b) pixel.g -= max(0., pixel.g - max(pixel.r, pixel.b)) * strength;
          else pixel.b -= max(0., pixel.b - max(pixel.r, pixel.g)) * strength;
        }
        gl_FragColor = vec4(pixel.rgb, pixel.a * alpha);
      }
    `);
    if (!vertex || !fragment) { if(vertex) gl.deleteShader(vertex); if(fragment) gl.deleteShader(fragment); return null; }
    const program = gl.createProgram(); if (!program) return null;
    gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program);
    gl.deleteShader(vertex); gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { gl.deleteProgram(program); return null; }
    const buffer = gl.createBuffer(), texture = gl.createTexture();
    if (!buffer || !texture) { gl.deleteProgram(program); if(buffer) gl.deleteBuffer(buffer); if(texture) gl.deleteTexture(texture); return null; }
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,1,1]), gl.STATIC_DRAW);
    gl.bindTexture(gl.TEXTURE_2D, texture); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.useProgram(program); gl.uniform1i(gl.getUniformLocation(program, "u_source"), 0);
    return { gl, program, buffer, texture, position: gl.getAttribLocation(program, "a_position"), key: gl.getUniformLocation(program, "u_key")!, tolerance: gl.getUniformLocation(program, "u_tolerance")!, softness: gl.getUniformLocation(program, "u_softness")!, spill: gl.getUniformLocation(program, "u_spill")! };
  }

  private applyEffects(
    effects: Clip["effects"],
    time: number,
    w: number,
    h: number,
    textBounds?: Bounds,
  ) {
    const ctx = this.layer.getContext("2d")!;
    const region = textBounds
      ? {
          x: textBounds.x - textBounds.width / 2,
          y: textBounds.y - textBounds.height / 2,
          width: textBounds.width,
          height: textBounds.height,
        }
      : { x: 0, y: 0, width: w, height: h };
    for (const e of effects) {
      const a = e.amount / 100;
      if (a <= 0) continue;
      ctx.save();
      ctx.globalCompositeOperation = "source-atop";
      switch (e.name) {
        case "Vignette": {
          const g = ctx.createRadialGradient(
            region.x + region.width / 2,
            region.y + region.height / 2,
            Math.min(region.width, region.height) * 0.15,
            region.x + region.width / 2,
            region.y + region.height / 2,
            Math.hypot(region.width, region.height) / 2,
          );
          g.addColorStop(0, "transparent");
          g.addColorStop(1, "rgba(0,0,0," + a + ")");
          ctx.fillStyle = g;
          ctx.fillRect(0, 0, w, h);
          break;
        }
        case "Grain": {
          let seed = Math.floor(time * 24) + 919;
          const rand = () => {
            seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
            return (seed >>> 0) / 4294967296;
          };
          const size = Math.max(1, w / 500);
          ctx.globalAlpha = a * 0.2;
          for (let i = 0; i < 6000; i++) {
            ctx.fillStyle = rand() > 0.5 ? "white" : "black";
            ctx.fillRect(
              region.x + rand() * region.width,
              region.y + rand() * region.height,
              size,
              size,
            );
          }
          break;
        }
        case "Glow":
          this.copy();
          ctx.globalCompositeOperation = "screen";
          ctx.globalAlpha = a * 0.55;
          ctx.filter = "blur(" + w / 65 + "px) brightness(1.25)";
          ctx.drawImage(this.temp, 0, 0);
          break;
        case "Pixelate": {
          const pw = Math.max(12, Math.round(w / (2 + a * 45)));
          this.pixel.width = pw;
          this.pixel.height = Math.max(1, Math.round((pw * h) / w));
          this.pixel
            .getContext("2d")!
            .drawImage(this.layer, 0, 0, this.pixel.width, this.pixel.height);
          ctx.imageSmoothingEnabled = false;
          ctx.globalCompositeOperation = "copy";
          ctx.drawImage(this.pixel, 0, 0, w, h);
          break;
        }
        case "Chromatic":
          this.copy();
          ctx.globalCompositeOperation = "screen";
          ctx.globalAlpha = a * 0.36;
          ctx.filter = "sepia(1) saturate(8) hue-rotate(280deg)";
          ctx.drawImage(this.temp, w * a * 0.016, 0);
          ctx.filter = "sepia(1) saturate(8) hue-rotate(130deg)";
          ctx.drawImage(this.temp, -w * a * 0.016, 0);
          break;
        case "Scanlines":
          ctx.fillStyle = "#030713";
          ctx.globalAlpha = a * 0.5;
          for (let y = 0; y < h; y += Math.max(4, h / 180))
            ctx.fillRect(0, y, w, Math.max(1, h / 500));
          break;
        case "Duotone": {
          const g = ctx.createLinearGradient(0, h, w, 0);
          g.addColorStop(0, "#46308d");
          g.addColorStop(1, "#ffbd88");
          ctx.globalCompositeOperation = textBounds ? "source-atop" : "color";
          ctx.globalAlpha = a;
          ctx.fillStyle = g;
          if (textBounds) this.maskedFill(ctx, g, w, h);
          else ctx.fillRect(0, 0, w, h);
          break;
        }
        case "Letterbox":
          ctx.fillStyle = "#000";
          ctx.fillRect(
            region.x,
            region.y,
            region.width,
            region.height * (textBounds ? 0.3 : 0.13) * a,
          );
          ctx.fillRect(
            region.x,
            region.y + region.height * (1 - (textBounds ? 0.3 : 0.13) * a),
            region.width,
            region.height * (textBounds ? 0.3 : 0.13) * a,
          );
          break;
        case "Prism": {
          const g = ctx.createLinearGradient(0, 0, w, h);
          g.addColorStop(0, "#a653ef");
          g.addColorStop(0.5, "#4ad4e2");
          g.addColorStop(1, "#ff9f70");
          ctx.globalCompositeOperation = textBounds ? "source-atop" : "screen";
          ctx.globalAlpha = a * 0.32 * (0.8 + 0.2 * Math.sin(time));
          ctx.fillStyle = g;
          if (textBounds) this.maskedFill(ctx, g, w, h);
          else ctx.fillRect(0, 0, w, h);
          break;
        }
        case "Wavy": {
          this.copy();
          ctx.globalCompositeOperation = "source-over";
          ctx.globalAlpha = 1;
          ctx.clearRect(0, 0, w, h);
          const waves = clamp(e.waves ?? 4, 1, 16);
          const warped = this.renderWavy(this.temp, w, h, a, waves, time);
          if (warped) ctx.drawImage(warped, 0, 0, w, h);
          break;
        }
      }
      ctx.restore();
    }
  }

  private maskedFill(
    ctx: CanvasRenderingContext2D,
    fill: CanvasGradient,
    w: number,
    h: number,
  ) {
    // Screen/color blends would otherwise paint a solid rectangle behind transparent text.
    this.copy();
    const mask = this.temp.getContext("2d")!;
    mask.save();
    mask.globalCompositeOperation = "source-in";
    mask.fillStyle = fill;
    mask.fillRect(0, 0, w, h);
    mask.restore();
    ctx.drawImage(this.temp, 0, 0);
  }

  private copy() {
    const ctx = this.temp.getContext("2d")!;
    ctx.clearRect(0, 0, this.temp.width, this.temp.height);
    ctx.drawImage(this.layer, 0, 0);
  }

  private renderWavy(
    source: HTMLCanvasElement,
    w: number,
    h: number,
    amount: number,
    waves: number,
    time: number,
  ) {
    if (!this.wavyState && !this.wavyAttempted) {
      this.wavyAttempted = true;
      this.wavyState = this.createWavyRenderer();
    }
    if (!this.wavyState) return this.renderWavyFallback(source, w, h, amount, waves, time);
    const { gl, program, texture, buffer, position, amplitude, waves: waveCount, phase } = this.wavyState;
    if (this.wavySurface.width !== w || this.wavySurface.height !== h) {
      this.wavySurface.width = w;
      this.wavySurface.height = h;
    }
    gl.viewport(0, 0, w, h);
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.uniform1f(amplitude, 0.035 * amount);
    gl.uniform1f(waveCount, waves);
    gl.uniform1f(phase, time * 1.5);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return this.wavySurface;
  }

  private createWavyRenderer() {
    const gl = this.wavySurface.getContext("webgl", {
      alpha: true,
      antialias: false,
      preserveDrawingBuffer: true,
      premultipliedAlpha: true,
    });
    if (!gl) return null;
    const compile = (kind: number, source: string) => {
      const shader = gl.createShader(kind);
      if (!shader) return null;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        gl.deleteShader(shader);
        return null;
      }
      return shader;
    };
    const vertex = compile(gl.VERTEX_SHADER, `
      attribute vec2 a_position;
      varying vec2 v_uv;
      void main() {
        gl_Position = vec4(a_position, 0.0, 1.0);
        v_uv = a_position * 0.5 + 0.5;
      }
    `);
    const fragment = compile(gl.FRAGMENT_SHADER, `
      precision mediump float;
      varying vec2 v_uv;
      uniform sampler2D u_source;
      uniform float u_amplitude;
      uniform float u_waves;
      uniform float u_phase;
      void main() {
        float x = v_uv.x + sin(v_uv.y * 6.28318530718 * u_waves + u_phase) * u_amplitude;
        gl_FragColor = (x < 0.0 || x > 1.0)
          ? vec4(0.0)
          : texture2D(u_source, vec2(x, v_uv.y));
      }
    `);
    if (!vertex || !fragment) return null;
    const program = gl.createProgram();
    if (!program) return null;
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
    const buffer = gl.createBuffer();
    const texture = gl.createTexture();
    const position = gl.getAttribLocation(program, "a_position");
    const amplitude = gl.getUniformLocation(program, "u_amplitude");
    const waves = gl.getUniformLocation(program, "u_waves");
    const phase = gl.getUniformLocation(program, "u_phase");
    if (!buffer || !texture || position < 0 || !amplitude || !waves || !phase) return null;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return { gl, program, texture, buffer, position, amplitude, waves, phase };
  }

  private renderWavyFallback(
    source: HTMLCanvasElement,
    w: number,
    h: number,
    amount: number,
    waves: number,
    time: number,
  ) {
    const input = source.getContext("2d")!.getImageData(0, 0, w, h);
    const output = new ImageData(w, h);
    const amplitude = w * 0.035 * amount;
    const phase = time * 1.5;
    for (let y = 0; y < h; y++) {
      const offset = Math.sin(((y + 0.5) / h) * Math.PI * 2 * waves + phase) * amplitude;
      for (let x = 0; x < w; x++) {
        const sourceX = x - offset;
        if (sourceX < 0 || sourceX >= w) continue;
        const left = Math.floor(sourceX);
        const right = Math.min(w - 1, left + 1);
        const mix = sourceX - left;
        const targetIndex = (y * w + x) * 4;
        const leftIndex = (y * w + left) * 4;
        const rightIndex = (y * w + right) * 4;
        for (let channel = 0; channel < 4; channel++)
          output.data[targetIndex + channel] = input.data[leftIndex + channel] * (1 - mix) + input.data[rightIndex + channel] * mix;
      }
    }
    this.wavyFallbackSurface.width = w;
    this.wavyFallbackSurface.height = h;
    this.wavyFallbackSurface.getContext("2d")!.putImageData(output, 0, 0);
    return this.wavyFallbackSurface;
  }

  private drawText(
    ctx: CanvasRenderingContext2D,
    t: TextClip,
    time: number,
    w: number,
    h: number,
  ) {
    const unit = w / 1920;
    const motion = textMotion(t, time);
    const amount = (name: string) =>
      ((t.effects ?? []).find((e) => e.name === name)?.amount ?? 0) / 100;
    const x =
      (t.x + motion.x) * w + Math.sin(time * 53) * w * 0.016 * amount("Shake");
    const y =
      (t.y + motion.y) * h + Math.cos(time * 47) * h * 0.018 * amount("Shake");
    const pulse =
      1 + amount("Pulse") * 0.05 * (1 + Math.sin(time * Math.PI * 3));
    const sx = motion.scaleX * pulse,
      sy = motion.scaleY * pulse;
    const rotation = t.rotation + motion.rotation,
      alpha = motion.opacity;
    const chars = Array.from(t.text);
    const text = chars
      .slice(0, Math.ceil(chars.length * motion.characters))
      .join("");
    const size = t.fontSize * unit;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rad(rotation));
    ctx.scale(sx, sy);
    const blur = motion.blur * w + (amount("Blur") * w) / 55;
    if (blur > 0) ctx.filter = `blur(${blur}px)`;
    ctx.font =
      (t.italic ? "italic " : "") +
      t.fontWeight +
      " " +
      size +
      'px "' +
      t.fontFamily +
      '"';
    ctx.textAlign = t.align;
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    ctx.letterSpacing = t.letterSpacing * unit + "px";
    const lines = text.split("\n"),
      fullLines = t.text.split("\n");
    const tw = Math.max(
      size,
      ...fullLines.map((line) => ctx.measureText(line).width),
    );
    const th = fullLines.length * size * t.lineHeight;
    const left = t.align === "center" ? -tw / 2 : t.align === "right" ? -tw : 0;
    for (const { direction, amount: reveal } of motion.reveals) {
      const pad = t.padding * unit + t.strokeWidth * unit * 2;
      const rw = tw + pad * 2,
        rh = th + pad * 2;
      let rx = left - pad,
        ry = -th / 2 - pad,
        cw = rw,
        ch = rh;
      if (direction === "Wipe left") {
        cw *= reveal;
        rx += rw - cw;
      }
      if (direction === "Wipe right") cw *= reveal;
      if (direction === "Wipe up") {
        ch *= reveal;
        ry += rh - ch;
      }
      if (direction === "Wipe down") ch *= reveal;
      ctx.beginPath();
      ctx.rect(rx, ry, cw, ch);
      ctx.clip();
    }
    if (t.background) {
      const pad = t.padding * unit;
      ctx.globalAlpha = alpha * t.backgroundOpacity;
      ctx.fillStyle = t.backgroundColor;
      ctx.beginPath();
      ctx.roundRect(
        left - pad,
        -th / 2 - pad,
        tw + pad * 2,
        th + pad * 2,
        Math.min(t.radius * unit, (th + pad * 2) / 2),
      );
      ctx.fill();
    }
    ctx.globalAlpha = alpha;
    if (t.fillMode === "linear" || t.fillMode === "radial") {
      const centerX = left + tw * clamp(t.gradientCenterX ?? 0.5, 0, 1);
      const centerY = -th / 2 + th * clamp(t.gradientCenterY ?? 0.5, 0, 1);
      let gradient: CanvasGradient;
      if (t.fillMode === "radial") {
        gradient = ctx.createRadialGradient(
          centerX, centerY, 0,
          centerX, centerY, Math.max(1, Math.max(tw, th) * clamp(t.gradientRadius ?? 0.7, 0.1, 2)),
        );
      } else {
        const angle = rad(t.gradientAngle ?? 0);
        const dx = Math.cos(angle), dy = Math.sin(angle);
        const extent = Math.abs(dx) * tw + Math.abs(dy) * th;
        gradient = ctx.createLinearGradient(
          left + tw / 2 - dx * extent / 2, -dy * extent / 2,
          left + tw / 2 + dx * extent / 2, dy * extent / 2,
        );
      }
      for (const stop of normalizeGradientStops(t.gradientStops))
        gradient.addColorStop(stop.position, stop.color);
      ctx.fillStyle = gradient;
    } else ctx.fillStyle = t.color;
    ctx.strokeStyle = t.strokeColor;
    ctx.lineWidth = t.strokeWidth * unit * 2;
    ctx.shadowColor = t.shadowColor;
    ctx.shadowBlur = t.shadowBlur * unit;
    ctx.shadowOffsetX = ctx.shadowOffsetY = t.shadowOffset * unit;
    const letterAnimation = motion.letterPop < 1;
    const animatedLetters = lines.map((line) => Array.from(line));
    const letterCount = animatedLetters.reduce((total, line) => total + line.length, 0);
    let letterIndex = 0;
    lines.forEach((line, i) => {
      const ly = (i - (fullLines.length - 1) / 2) * size * t.lineHeight;
      if (!letterAnimation || letterCount === 0) {
        if (t.strokeWidth) ctx.strokeText(line, 0, ly);
        ctx.fillText(line, 0, ly);
        return;
      }
      const glyphs = animatedLetters[i];
      const spacing = t.letterSpacing * unit;
      ctx.letterSpacing = "0px";
      const widths = glyphs.map((glyph) => ctx.measureText(glyph).width);
      const lineWidth = widths.reduce((total, width) => total + width, 0) + spacing * Math.max(0, glyphs.length - 1);
      let cursor = t.align === "center" ? -lineWidth / 2 : t.align === "right" ? -lineWidth : 0;
      glyphs.forEach((glyph, index) => {
        const width = widths[index];
        const letterProgress = letterPopProgress(motion.letterPop, letterIndex++, letterCount);
        if (letterProgress > 0) {
          const eased = 1 - (1 - letterProgress) ** 3;
          const scale = 0.14 + 0.86 * eased + Math.sin(letterProgress * Math.PI) * 0.14;
          const centerX = cursor + width / 2;
          ctx.save();
          ctx.globalAlpha = alpha * eased;
          ctx.textAlign = "left";
          ctx.translate(centerX, ly);
          ctx.scale(scale, scale);
          ctx.translate(-centerX, -ly);
          if (t.strokeWidth) ctx.strokeText(glyph, cursor, ly);
          ctx.fillText(glyph, cursor, ly);
          ctx.restore();
        }
        cursor += width + spacing;
      });
    });
    ctx.restore();
    const centerOffset = left + tw / 2;
    this.bounds.push({
      id: t.id,
      kind: "text",
      x: x + centerOffset * sx * Math.cos(rad(rotation)),
      y: y + centerOffset * sx * Math.sin(rad(rotation)),
      width: Math.abs((tw + t.padding * unit * 2) * sx),
      height: Math.abs((th + t.padding * unit * 2) * sy),
      rotation,
      flipX: sx < 0,
      flipY: sy < 0,
    });
  }
}

export function hitBounds(bounds: Bounds[], x: number, y: number) {
  return [...bounds].reverse().find((b) => {
    const dx = x - b.x,
      dy = y - b.y,
      a = -rad(b.rotation);
    return (
      Math.abs(dx * Math.cos(a) - dy * Math.sin(a)) <= b.width / 2 &&
      Math.abs(dx * Math.sin(a) + dy * Math.cos(a)) <= b.height / 2
    );
  });
}

export function drawDemo(
  ctx: CanvasRenderingContext2D,
  asset: Asset,
  w: number,
  h: number,
  progress: number,
) {
  const colors = (
    {
      aurora: ["#07182b", "#1b6a78", "#7af3c7"],
      alpine: ["#1e2f56", "#8c83c4", "#ffd3a4"],
      city: ["#08111f", "#3f3471", "#f5a75a"],
    } as Record<string, string[]>
  )[asset.theme] ?? ["#07182b", "#1b6a78", "#7af3c7"];
  const gradient = ctx.createLinearGradient(0, 0, w, h);
  gradient.addColorStop(0, colors[0]);
  gradient.addColorStop(0.58, colors[1]);
  gradient.addColorStop(1, colors[2]);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, w, h);
  const glow = ctx.createRadialGradient(
    w * (0.62 + Math.sin(progress * Math.PI) * 0.05),
    h * 0.25,
    1,
    w * 0.62,
    h * 0.25,
    w * 0.48,
  );
  glow.addColorStop(0, "rgba(255,255,255,.34)");
  glow.addColorStop(1, "transparent");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#101822";
  ctx.beginPath();
  ctx.moveTo(0, h);
  [
    [0, 0.72],
    [0.22, 0.48],
    [0.39, 0.69],
    [0.61, 0.39],
    [0.82, 0.67],
    [1, 0.5],
    [1, 1],
  ].forEach(([x, y]) => ctx.lineTo(w * x, h * y));
  ctx.closePath();
  ctx.fill();
  if (asset.theme === "city")
    for (let i = 0; i < 14; i++) {
      const x = (i * w) / 14,
        bh = h * (0.12 + ((i / 14) % 0.28));
      ctx.fillStyle = "#090d18";
      ctx.fillRect(x, h - bh, w / 17, bh);
      ctx.fillStyle = "#ffbf63";
      ctx.fillRect(x + w / 70, h - bh + h / 22, w / 130, h / 75);
    }
}
