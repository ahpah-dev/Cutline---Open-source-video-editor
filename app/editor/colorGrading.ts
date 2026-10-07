/** Display-referred grading for the editor's sRGB/Rec.709, 8-bit Canvas pipeline. */
export type CurvePoint = { x: number; y: number };
export const CURVE_CHANNELS = ["master", "red", "green", "blue"] as const;
export type CurveChannel = (typeof CURVE_CHANNELS)[number];
export type ColorCurves = Record<CurveChannel, CurvePoint[]>;
export const GRADE_RANGES = {
  exposure: [-4, 4], tint: [-100, 100], highlights: [-100, 100], shadows: [-100, 100],
  whites: [-100, 100], blacks: [-100, 100], vibrance: [-100, 100], hue: [-180, 180],
  shadowHue: [0, 360], shadowStrength: [0, 100], shadowLuma: [-100, 100],
  midtoneHue: [0, 360], midtoneStrength: [0, 100], midtoneLuma: [-100, 100],
  highlightHue: [0, 360], highlightStrength: [0, 100], highlightLuma: [-100, 100],
} as const;
export type GradeProperty = keyof typeof GRADE_RANGES;
export type ColorGrading = Partial<Record<GradeProperty, number>> & {
  gradingEnabled?: boolean;
  colorCurves?: ColorCurves;
};
export const GRADE_DEFAULTS: Record<GradeProperty, number> = {
  exposure: 0, tint: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0, vibrance: 0, hue: 0,
  shadowHue: 210, shadowStrength: 0, shadowLuma: 0,
  midtoneHue: 30, midtoneStrength: 0, midtoneLuma: 0,
  highlightHue: 45, highlightStrength: 0, highlightLuma: 0,
};
const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
export function identityCurves(): ColorCurves {
  return Object.fromEntries(CURVE_CHANNELS.map((channel) => [channel, [{ x: 0, y: 0 }, { x: 1, y: 1 }]])) as ColorCurves;
}
export function normalizeCurves(raw: unknown): ColorCurves {
  const value = raw && typeof raw === "object" ? raw as Partial<ColorCurves> : {};
  return Object.fromEntries(CURVE_CHANNELS.map((channel) => {
    const points = Array.isArray(value[channel]) ? value[channel]!.slice(0, 12).filter((p) =>
      p && Number.isFinite(p.x) && Number.isFinite(p.y)).map((p) => ({ x: clamp(p.x), y: clamp(p.y) })) : [];
    points.sort((a, b) => a.x - b.x);
    const unique = points.filter((p, i) => !i || p.x - points[i - 1].x >= .001);
    if (!unique.length) return [channel, [{ x: 0, y: 0 }, { x: 1, y: 1 }]];
    if (unique[0].x > 0) unique.unshift({ x: 0, y: unique[0].y });
    if (unique.at(-1)!.x < 1) unique.push({ x: 1, y: unique.at(-1)!.y });
    return [channel, unique.length <= 12 ? unique : [unique[0], ...unique.slice(1, -1).slice(0, 10), unique.at(-1)!]];
  })) as ColorCurves;
}
export function normalizeGrade(raw: ColorGrading) {
  const values = Object.fromEntries(Object.entries(GRADE_RANGES).map(([key, range]) => {
    const name = key as GradeProperty, value = raw[name];
    return [name, typeof value === "number" && Number.isFinite(value) ? clamp(value, range[0], range[1]) : GRADE_DEFAULTS[name]];
  })) as Record<GradeProperty, number>;
  return { ...values, gradingEnabled: raw.gradingEnabled !== false, colorCurves: normalizeCurves(raw.colorCurves) };
}
export function hasAdvancedGrade(raw: ColorGrading): boolean {
  const g = normalizeGrade(raw);
  if (!g.gradingEnabled) return false;
  return Object.keys(GRADE_RANGES).some((key) => !key.endsWith("Hue") && g[key as GradeProperty] !== GRADE_DEFAULTS[key as GradeProperty]) ||
    CURVE_CHANNELS.some((channel) => g.colorCurves[channel].some((p) => Math.abs(p.x - p.y) > .00001));
}
/** Shape-preserving monotone cubic interpolation: smooth without ringing or overshooting. */
export function curveValue(points: CurvePoint[], value: number): number {
  const x = clamp(value), n = points.length;
  if (x <= points[0].x) return points[0].y;
  if (x >= points[n - 1].x) return points[n - 1].y;
  const slopes = points.slice(0, -1).map((p, i) => (points[i + 1].y - p.y) / (points[i + 1].x - p.x));
  const tangent = (i: number) => {
    if (i === 0) return slopes[0];
    if (i === n - 1) return slopes[n - 2];
    const a = slopes[i - 1], b = slopes[i];
    if (a * b <= 0) return 0;
    const h0 = points[i].x - points[i - 1].x, h1 = points[i + 1].x - points[i].x;
    return (3 * (h0 + h1)) / ((2 * h1 + h0) / a + (h1 + 2 * h0) / b);
  };
  const index = points.findIndex((p) => p.x > x) - 1, a = points[index], b = points[index + 1];
  const h = b.x - a.x, t = (x - a.x) / h;
  return clamp((2 * t ** 3 - 3 * t ** 2 + 1) * a.y + (t ** 3 - 2 * t ** 2 + t) * h * tangent(index) +
    (-2 * t ** 3 + 3 * t ** 2) * b.y + (t ** 3 - t ** 2) * h * tangent(index + 1));
}
/** Pre-composed master+RGB lookup table shared by the GPU and CPU render paths. */
export function curveTable(curves: ColorCurves): Float32Array {
  const data = new Float32Array(256 * 3);
  for (let x = 0; x < 256; x++) {
    const master = curveValue(curves.master, x / 255);
    data[x * 3] = curveValue(curves.red, master);
    data[x * 3 + 1] = curveValue(curves.green, master);
    data[x * 3 + 2] = curveValue(curves.blue, master);
  }
  return data;
}
export function wheelColor(hue: number): [number, number, number] {
  const h = ((hue % 360) + 360) % 360 / 60, x = 1 - Math.abs(h % 2 - 1);
  const rgb: [number, number, number] = h < 1 ? [1, x, 0] : h < 2 ? [x, 1, 0] : h < 3 ? [0, 1, x] : h < 4 ? [0, x, 1] : h < 5 ? [x, 0, 1] : [1, 0, x];
  const luma = rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
  return rgb.map((c) => c - luma) as [number, number, number];
}
const smooth = (a: number, b: number, v: number) => { const t = clamp((v - a) / (b - a)); return t * t * (3 - 2 * t); };
type PreparedGrade = ReturnType<typeof prepareGrade>;
function prepareGrade(raw: ColorGrading, table?: Float32Array) {
  const g = normalizeGrade(raw);
  const wheel = (hue: number, strength: number, lightness: number) => wheelColor(hue).map((c) => c * strength / 200 + lightness / 625);
  return { g, table: table ?? curveTable(g.colorCurves), exposure: 2 ** g.exposure,
    tint: [Math.exp(g.tint * .00125), Math.exp(-g.tint * .0025), Math.exp(g.tint * .00125)],
    shadow: wheel(g.shadowHue, g.shadowStrength, g.shadowLuma), midtone: wheel(g.midtoneHue, g.midtoneStrength, g.midtoneLuma),
    highlight: wheel(g.highlightHue, g.highlightStrength, g.highlightLuma),
    cos: Math.cos(g.hue * Math.PI / 180), sin: Math.sin(g.hue * Math.PI / 180) };
}
function gradePrepared(rgb: readonly number[], p: PreparedGrade): [number, number, number] {
  let [r, g, b] = rgb.map((v, i) => v * p.exposure * p.tint[i]);
  const luma = clamp(r * .2126 + g * .7152 + b * .0722), shadow = 1 - smooth(.05, .65, luma), highlight = smooth(.35, .95, luma);
  const tone = p.g.shadows / 450 * shadow + p.g.highlights / 450 * highlight +
    p.g.blacks / 700 * (1 - luma) ** 4 + p.g.whites / 700 * luma ** 4;
  const rgbTone = [r, g, b].map((v, i) => v + tone + p.shadow[i] * shadow + p.midtone[i] * (4 * luma * (1 - luma)) + p.highlight[i] * highlight);
  [r, g, b] = rgbTone;
  const average = (r + g + b) / 3, sin = p.sin / Math.sqrt(3), cos = p.cos;
  [r, g, b] = [r * cos + (b - g) * sin + average * (1 - cos), g * cos + (r - b) * sin + average * (1 - cos), b * cos + (g - r) * sin + average * (1 - cos)];
  const lum = r * .2126 + g * .7152 + b * .0722;
  const sat = 1 + p.g.vibrance / 100 * (1 - clamp(Math.max(r, g, b) - Math.min(r, g, b))) * .8;
  return [r, g, b].map((v, channel) => {
    const x = clamp(lum + (v - lum) * sat) * 255, at = Math.floor(x), mix = x - at;
    return p.table[at * 3 + channel] * (1 - mix) + p.table[Math.min(at + 1, 255) * 3 + channel] * mix;
  }) as [number, number, number];
}
export function gradeRgb(rgb: readonly number[], raw: ColorGrading): [number, number, number] {
  return !hasAdvancedGrade(raw) ? [...rgb] as [number, number, number] : gradePrepared(rgb, prepareGrade(raw));
}
export function gradePixels(pixels: Uint8ClampedArray, raw: ColorGrading) {
  if (!hasAdvancedGrade(raw)) return;
  const p = prepareGrade(raw);
  for (let i = 0; i < pixels.length; i += 4) {
    if (!pixels[i + 3]) continue;
    const rgb = gradePrepared([pixels[i] / 255, pixels[i + 1] / 255, pixels[i + 2] / 255], p);
    for (let c = 0; c < 3; c++) pixels[i + c] = Math.round(rgb[c] * 255);
  }
}
export const GRADE_KEYS = ["gradingEnabled", "colorCurves", ...Object.keys(GRADE_RANGES), "brightness", "contrast", "saturation", "temperature", "filter"];
export function resetGrade<T extends ColorGrading & { propertyKeyframes?: Record<string, unknown> }>(clip: T): T {
  return { ...clip, ...GRADE_DEFAULTS, gradingEnabled: true, colorCurves: identityCurves(),
    brightness: 100, contrast: 100, saturation: 100, temperature: 0, filter: "Original",
    propertyKeyframes: Object.fromEntries(Object.entries(clip.propertyKeyframes ?? {}).filter(([key]) => !GRADE_KEYS.includes(key))) };
}

/** One reusable GPU pass per renderer; CPU fallback retains full resolution and alpha. */
export class ColorGradeRenderer {
  private canvas: HTMLCanvasElement | null = null;
  private fallback: HTMLCanvasElement | null = null;
  private attempted = false;
  private signature = "";
  private tableSignature = "";
  private table: Float32Array | null = null;
  private state: { gl: WebGLRenderingContext; program: WebGLProgram; texture: WebGLTexture; curves: WebGLTexture;
    buffer: WebGLBuffer; uniforms: Record<string, WebGLUniformLocation | null>; position: number } | null = null;
  private init() {
    this.attempted = true; this.canvas = document.createElement("canvas");
    const gl = this.canvas.getContext("webgl", { alpha: true, antialias: false, preserveDrawingBuffer: true, premultipliedAlpha: false });
    if (!gl) return;
    const shader = (kind: number, text: string) => {
      const s = gl.createShader(kind); if (!s) return null; gl.shaderSource(s, text); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { gl.deleteShader(s); return null; } return s;
    };
    const vertex = shader(gl.VERTEX_SHADER, "attribute vec2 a_position; varying vec2 v_uv; void main(){gl_Position=vec4(a_position,0.,1.);v_uv=a_position*.5+.5;}");
    const fragment = shader(gl.FRAGMENT_SHADER, `precision highp float;
      varying vec2 v_uv; uniform sampler2D u_source; uniform sampler2D u_curves;
      uniform float u_exposure; uniform vec3 u_tint; uniform vec4 u_tone;
      uniform vec3 u_shadow; uniform vec3 u_midtone; uniform vec3 u_highlight; uniform vec3 u_hue;
      float curve(float x,int c){vec3 value=texture2D(u_curves,vec2((clamp(x,0.,1.)*255.+.5)/256.,.5)).rgb;return c==0?value.r:c==1?value.g:value.b;}
      void main(){vec4 pixel=texture2D(u_source,v_uv);vec3 rgb=pixel.rgb*u_exposure*u_tint;
        float lum=clamp(dot(rgb,vec3(.2126,.7152,.0722)),0.,1.);
        float shadow=1.-smoothstep(.05,.65,lum),highlight=smoothstep(.35,.95,lum);
        float tone=u_tone.x*shadow+u_tone.y*highlight+u_tone.z*pow(1.-lum,4.)+u_tone.w*pow(lum,4.);
        rgb+=vec3(tone)+u_shadow*shadow+u_midtone*(4.*lum*(1.-lum))+u_highlight*highlight;
        float avg=(rgb.r+rgb.g+rgb.b)/3.;rgb=rgb*u_hue.x+vec3(rgb.b-rgb.g,rgb.r-rgb.b,rgb.g-rgb.r)*u_hue.y+vec3(avg)*(1.-u_hue.x);
        float luma=dot(rgb,vec3(.2126,.7152,.0722));float sat=1.+u_hue.z*(1.-clamp(max(rgb.r,max(rgb.g,rgb.b))-min(rgb.r,min(rgb.g,rgb.b)),0.,1.))*.8;
        rgb=vec3(luma)+(rgb-vec3(luma))*sat;
        gl_FragColor=vec4(curve(rgb.r,0),curve(rgb.g,1),curve(rgb.b,2),pixel.a);
      }`);
    if (!vertex || !fragment) { if (vertex) gl.deleteShader(vertex); if (fragment) gl.deleteShader(fragment); return; }
    const program = gl.createProgram(); if (!program) { gl.deleteShader(vertex); gl.deleteShader(fragment); return; }
    gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program);
    gl.deleteShader(vertex); gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { gl.deleteProgram(program); return; }
    const texture = gl.createTexture(), curves = gl.createTexture(), buffer = gl.createBuffer();
    if (!texture || !curves || !buffer) { if (texture) gl.deleteTexture(texture); if (curves) gl.deleteTexture(curves); if (buffer) gl.deleteBuffer(buffer); gl.deleteProgram(program); return; }
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    for (const t of [texture, curves]) { gl.bindTexture(gl.TEXTURE_2D, t); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); }
    gl.useProgram(program); gl.uniform1i(gl.getUniformLocation(program, "u_source"), 0); gl.uniform1i(gl.getUniformLocation(program, "u_curves"), 1);
    const uniforms = Object.fromEntries(["exposure", "tint", "tone", "shadow", "midtone", "highlight", "hue"].map((key) => [key, gl.getUniformLocation(program, `u_${key}`)]));
    this.state = { gl, program, texture, curves, buffer, position: gl.getAttribLocation(program, "a_position"), uniforms };
  }
  render(source: HTMLCanvasElement, raw: ColorGrading): HTMLCanvasElement {
    if (!hasAdvancedGrade(raw)) return source;
    if (!this.attempted) this.init();
    const grade = normalizeGrade(raw), curveSignature = JSON.stringify(grade.colorCurves);
    if (curveSignature !== this.tableSignature || !this.table) {
      this.table = curveTable(grade.colorCurves); this.tableSignature = curveSignature;
    }
    const p = prepareGrade(grade, this.table), state = this.state;
    if (state && !state.gl.isContextLost()) {
      const { gl, program, buffer, texture, curves, position, uniforms: u } = state;
      const canvas = this.canvas!;
      if (canvas.width !== source.width || canvas.height !== source.height) { canvas.width = source.width; canvas.height = source.height; }
      gl.viewport(0, 0, canvas.width, canvas.height); gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer); gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texture); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, curves);
      const signature = JSON.stringify(p.g.colorCurves);
      if (signature !== this.signature) {
        const data = new Uint8Array(p.table.length); for (let i = 0; i < data.length; i++) data[i] = Math.round(p.table[i] * 255);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, 256, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, data); this.signature = signature;
      }
      gl.uniform1f(u.exposure, p.exposure); gl.uniform3fv(u.tint, p.tint);
      gl.uniform4f(u.tone, p.g.shadows / 450, p.g.highlights / 450, p.g.blacks / 700, p.g.whites / 700);
      gl.uniform3fv(u.shadow, p.shadow); gl.uniform3fv(u.midtone, p.midtone); gl.uniform3fv(u.highlight, p.highlight);
      gl.uniform3f(u.hue, p.cos, p.sin / Math.sqrt(3), p.g.vibrance / 100); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      return canvas;
    }
    this.fallback ??= document.createElement("canvas"); const canvas = this.fallback;
    if (canvas.width !== source.width || canvas.height !== source.height) { canvas.width = source.width; canvas.height = source.height; }
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    context.clearRect(0, 0, canvas.width, canvas.height); context.drawImage(source, 0, 0);
    const image = context.getImageData(0, 0, canvas.width, canvas.height); gradePixels(image.data, raw); context.putImageData(image, 0, 0); return canvas;
  }
  dispose() {
    const s = this.state;
    if (s) { s.gl.deleteProgram(s.program); s.gl.deleteBuffer(s.buffer); s.gl.deleteTexture(s.texture); s.gl.deleteTexture(s.curves); s.gl.getExtension("WEBGL_lose_context")?.loseContext(); }
    for (const c of [this.canvas, this.fallback]) if (c) { c.width = 0; c.height = 0; }
    this.state = null; this.canvas = this.fallback = null; this.attempted = false; this.signature = "";
    this.table = null; this.tableSignature = "";
  }
}
