import { makeClip, newProject, type Asset } from "../app/editor/model";
import { TRANSITIONS } from "../app/editor/presets";
import { Renderer } from "../app/editor/renderer";
import { applyTransition } from "../app/editor/transitions";

type Check = (name: string, run: () => unknown) => Promise<void>;
type Assert = (condition: unknown, message: string) => void;
function canvas(w = 320, h = 180) {
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  c.getContext("2d", { willReadFrequently: true }); return c;
}
const data = (c: HTMLCanvasElement) => c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
const hash = (c: HTMLCanvasElement) => { let value = 2166136261; for (const n of data(c)) value = Math.imul(value ^ n, 16777619); return value >>> 0; };
function paint(c: HTMLCanvasElement, incoming: boolean) {
  const ctx = c.getContext("2d")!, w = c.width, h = c.height;
  const gradient = ctx.createLinearGradient(0, h, w, 0);
  gradient.addColorStop(0, incoming ? "#204bba" : "#f43b59");
  gradient.addColorStop(1, incoming ? "#19c9d1" : "#f3c94a");
  ctx.fillStyle = gradient; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = incoming ? "#eee8ff" : "#262840";
  ctx.fillRect(w * .08, h * .12, w * .24, h * .42);
  ctx.fillRect(w * .67, h * .72, w * .25, h * .13);
}
function pair(outgoing: HTMLCanvasElement, incoming: HTMLCanvasElement, name: string, progress: number) {
  const c = canvas(outgoing.width, outgoing.height), ctx = c.getContext("2d")!;
  for (const [source, side] of [[outgoing, "out"], [incoming, "in"]] as const) {
    ctx.save(); applyTransition(ctx, name, progress, side, c.width, c.height); ctx.drawImage(source, 0, 0); ctx.restore();
  }
  return c;
}

export async function runTransitionTests(check: Check, assert: Assert) {
  await check("All 44 transitions retain exact full-frame outgoing/incoming endpoints at landscape and portrait ratios", () => {
    for (const [w, h] of [[320, 180], [180, 320]]) {
      const outgoing = canvas(w, h), incoming = canvas(w, h); paint(outgoing, false); paint(incoming, true);
      for (const transition of TRANSITIONS.filter((item) => item.name !== "None")) {
        assert(hash(pair(outgoing, incoming, transition.name, 0)) === hash(outgoing), transition.name + " changed its outgoing endpoint");
        assert(hash(pair(outgoing, incoming, transition.name, 1)) === hash(incoming), transition.name + " changed its incoming endpoint");
      }
    }
  });
  await check("Expanded transition presets produce 42 distinct animated Canvas treatments rather than aliases", () => {
    const outgoing = canvas(), incoming = canvas(); paint(outgoing, false); paint(incoming, true);
    const signatures = new Map<string, string>();
    for (const transition of TRANSITIONS.filter((item) => !["None", "Fade black", "Fade white"].includes(item.name))) {
      const signature = [0.23, 0.63].map((p) => hash(pair(outgoing, incoming, transition.name, p))).join(":");
      assert(!signatures.has(signature), transition.name + " duplicates " + signatures.get(signature));
      signatures.set(signature, transition.name);
    }
    assert(signatures.size === 42, "Transition collection must contain 42 distinct non-matte treatments");
  });
  await check("Complementary geometric reveals retain opaque coverage within Canvas edge-antialias tolerance", () => {
    const white = canvas(), ctx = white.getContext("2d")!; ctx.fillStyle = "white"; ctx.fillRect(0, 0, white.width, white.height);
    for (const transition of TRANSITIONS.filter((item) => item.category === "Reveal")) {
      for (const progress of [.19, .43, .71]) {
        const pixels = data(pair(white, white, transition.name, progress));
        let minimum = 255, minimumIndex = 0;
        for (let i = 3; i < pixels.length; i += 4) if (pixels[i] < minimum) { minimum = pixels[i]; minimumIndex = (i - 3) / 4; }
        // Curved paths and their even-odd complements are independently antialiased
        // by Canvas. Permit a single edge pixel's small raster rounding, not a gap.
        assert(minimum >= 240, transition.name + " created a coverage crack: " + minimum + " at " + minimumIndex % 320 + "," + Math.floor(minimumIndex / 320) + " (" + progress + ")");
      }
    }
  });
  await check("Empty transparent transition layers never paint a matte or opaque pixels over lower tracks", () => {
    const empty = canvas();
    for (const transition of TRANSITIONS) {
      for (const progress of [.13, .5, .87]) {
        const pixels = data(pair(empty, empty, transition.name, progress));
        assert(pixels.every((n) => n === 0), transition.name + " invented source pixels in transparent layers");
      }
    }
  });
  await check("Diagonal pushes and spin transitions retain full frame coverage throughout the movement", () => {
    const white = canvas(), ctx = white.getContext("2d")!; ctx.fillStyle = "white"; ctx.fillRect(0, 0, white.width, white.height);
    for (const name of ["Push up left", "Push up right", "Spin clockwise", "Spin counterclockwise"]) {
      for (const progress of [.12, .32, .5, .78]) {
        const pixels = data(pair(white, white, name, progress));
        let minimum = 255;
        for (let i = 3; i < pixels.length; i += 4) minimum = Math.min(minimum, pixels[i]);
        assert(minimum >= 248, name + " exposed an uncovered corner: " + minimum);
      }
    }
  });
  await check("Expanded transitions affect both real timeline clips before and after the cut and match export frames", async () => {
    const out = canvas(), into = canvas(); paint(out, false); paint(into, true);
    const images = await Promise.all([out, into].map(async (source) => { const image = new Image(); image.src = source.toDataURL(); await image.decode(); return image; }));
    const assets: Asset[] = images.map((_, index) => ({ id: "transition-" + index, name: "test.png", kind: "image", width: 320, height: 180, duration: 3, theme: "image", sizeLabel: "1 KB" }));
    const outgoing = { ...makeClip(assets[0]), sourceEnd: 2, track: 1 };
    const incoming = { ...makeClip(assets[1]), start: 2, sourceEnd: 2, track: 1, transitionDuration: 1 };
    const project = newProject(); project.assets = assets; project.clips = [outgoing, incoming]; project.background = "#132237";
    const sources = new Map([[outgoing.id, images[0]], [incoming.id, images[1]]]);
    const preview = canvas(), exportFrame = canvas(), base = canvas(), r = new Renderer(), exportRenderer = new Renderer();
    try {
      for (const transition of TRANSITIONS.filter((item) => item.name !== "None")) {
        incoming.transition = transition.name;
        for (const time of [1.78, 2.08]) {
          r.draw(preview, project, time, sources);
          r.draw(base, { ...project, clips: [time < 2 ? outgoing : { ...incoming, transition: "None" }] }, time, sources);
          assert(hash(preview) !== hash(base), transition.name + " did not animate the " + (time < 2 ? "outgoing" : "incoming") + " side");
          exportRenderer.draw(exportFrame, project, time, sources);
          assert(hash(preview) === hash(exportFrame), transition.name + " differs between preview and export");
        }
      }
    } finally { r.dispose(); exportRenderer.dispose(); }
  });
  await check("Masked upper-track black/white dips preserve the stationary lower backdrop and exact transparent endpoints", async () => {
    const lower = canvas(), out = canvas(), into = canvas(); paint(lower, true); paint(out, false); paint(into, true);
    const images = await Promise.all([lower, out, into].map(async (source) => { const image = new Image(); image.src = source.toDataURL(); await image.decode(); return image; }));
    const assets: Asset[] = images.map((_, index) => ({ id: "dip-" + index, name: "test.png", kind: "image", width: 320, height: 180, duration: 5, theme: "image", sizeLabel: "1 KB" }));
    const lowerClip = { ...makeClip(assets[0]), track: 0, sourceEnd: 5 };
    const outgoing = { ...makeClip(assets[1]), sourceEnd: 2, track: 1, maskShape: "Rectangle" as const, maskWidth: .4, maskHeight: .4 };
    const incoming = { ...makeClip(assets[2]), start: 2, sourceEnd: 2, track: 1, transitionDuration: 1, maskShape: "Rectangle" as const, maskWidth: .4, maskHeight: .4 };
    const project = newProject(); project.assets = assets; project.clips = [lowerClip, outgoing, incoming];
    const sources = new Map([[lowerClip.id, images[0]], [outgoing.id, images[1]], [incoming.id, images[2]]]);
    const result = canvas(), lowerFrame = canvas(), endpoint = canvas(), renderer = new Renderer();
    const at = (c: HTMLCanvasElement, x: number, y: number) => [...c.getContext("2d")!.getImageData(x, y, 1, 1).data];
    try {
      renderer.draw(lowerFrame, { ...project, clips: [lowerClip] }, 2, sources);
      const backdrop = at(lowerFrame, 10, 10);
      for (const mode of ["Normal", "Multiply"] as const) {
        outgoing.blendMode = mode;
        incoming.blendMode = mode === "Normal" ? "Normal" : "Screen";
        for (const [name, channel] of [["Fade black", 0], ["Fade white", 255]] as const) {
          incoming.transition = name;
          outgoing.opacity = incoming.opacity = 1;
          renderer.draw(result, project, 2, sources);
          const center = at(result, 160, 90);
          assert(center.every((n, i) => Math.abs(n - (i === 3 ? 255 : channel)) <= 1), name + " did not reach its scoped matte midpoint");
          for (const time of [1.5, 1.75, 2, 2.25, 2.49999]) {
            renderer.draw(result, project, time, sources);
            assert(at(result, 10, 10).every((n, i) => Math.abs(n - backdrop[i]) <= 1), name + " changed the lower track outside the mask (" + mode + ")");
          }
          outgoing.opacity = incoming.opacity = .65;
          for (const [time, clips] of [[1.5, [lowerClip, outgoing]], [2.49999, [lowerClip, { ...incoming, transition: "None" as const }]]] as const) {
            renderer.draw(result, project, time, sources);
            renderer.draw(endpoint, { ...project, clips: [...clips] }, time, sources);
            assert(at(result, 160, 90).every((n, i) => Math.abs(n - at(endpoint, 160, 90)[i]) <= 2), name + " changed its semi-transparent " + (time < 2 ? "outgoing" : "incoming") + " endpoint (" + mode + ")");
          }
        }
      }
    } finally { renderer.dispose(); }
  });
  await check("Filtered crossfades blend their soft source edges once: Screen on black matches Normal", async () => {
    const out = canvas(), into = canvas(); paint(out, false); paint(into, true);
    const images = await Promise.all([out, into].map(async (source) => { const image = new Image(); image.src = source.toDataURL(); await image.decode(); return image; }));
    const assets: Asset[] = images.map((_, index) => ({ id: "filter-dip-" + index, name: "test.png", kind: "image", width: 320, height: 180, duration: 4, theme: "image", sizeLabel: "1 KB" }));
    const outgoing = { ...makeClip(assets[0]), sourceEnd: 2, track: 1, opacity: .8 };
    const incoming = { ...makeClip(assets[1]), start: 2, sourceEnd: 2, track: 1, opacity: .65, transitionDuration: 1 };
    const project = newProject(); project.assets = assets; project.clips = [outgoing, incoming]; project.background = "#000000";
    const sources = new Map([[outgoing.id, images[0]], [incoming.id, images[1]]]);
    const normal = canvas(), screen = canvas(), renderer = new Renderer();
    try {
      for (const name of ["Blur", "Cross zoom"] as const) {
        incoming.transition = name;
        for (const time of [1.63, 2, 2.37, 2.49]) {
          outgoing.blendMode = incoming.blendMode = "Normal"; renderer.draw(normal, project, time, sources);
          outgoing.blendMode = incoming.blendMode = "Screen"; renderer.draw(screen, project, time, sources);
          const a = data(normal), b = data(screen); let maximum = 0;
          for (let i = 0; i < a.length; i++) maximum = Math.max(maximum, Math.abs(a[i] - b[i]));
          assert(maximum <= 2, name + " multiplied soft transition alpha twice: delta=" + maximum + " at " + time);
        }
      }
    } finally { renderer.dispose(); }
  });
}
