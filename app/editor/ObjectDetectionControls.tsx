/* Native source thumbnails stay local in the offline desktop app. */
/* eslint-disable @next/next/no-img-element */
import { useEffect, useRef, useState } from "react";
import { Download, ScanSearch, X, Crop, Scan } from "lucide-react";
import { clipDuration, clamp, dimensions, type Asset, type Clip, type Project } from "./model";
import { normalizeCrop } from "./crop";
import { detectionCrop, detectionMask, normalizeDetections, type DetectedObject } from "./objectDetection";
import type { VisualCompositing } from "./visualCompositing";

type Analysis = { objects: DetectedObject[]; image: string; width: number; height: number; clipId: string; sourceTime: number; crop: ReturnType<typeof normalizeCrop>; signature: string };
const sourceSignature = (clip: Clip, asset: Asset) => JSON.stringify([clip.id, asset.id, asset.url, clip.sourceStart, clip.sourceEnd, clip.frozenAt, clip.speed, normalizeCrop(clip.crop)]);
const cancelled = () => new DOMException("Object detection cancelled", "AbortError");
async function captureSource(clip: Clip, asset: Asset, time: number, signal: AbortSignal) {
  if (!asset.url || asset.kind === "audio" || asset.kind === "demo") throw new Error("Import or relink an image or video first.");
  const element = asset.kind === "image" ? new Image() : document.createElement("video");
  const wait = (event: string) => new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(cancelled()); return; }
    const cleanup = () => { clearTimeout(timer); element.removeEventListener(event, done); element.removeEventListener("error", fail); signal.removeEventListener("abort", abort); };
    const done = () => { cleanup(); resolve(); }, fail = () => { cleanup(); reject(new Error("Source could not be decoded. Relink it or try a standard MP4 or image.")); }, abort = () => { cleanup(); reject(cancelled()); };
    const timer = setTimeout(() => { cleanup(); reject(new Error("Source loading timed out. Relink or re-import this file.")); }, 20000);
    element.addEventListener(event, done, { once: true }); element.addEventListener("error", fail, { once: true }); signal.addEventListener("abort", abort, { once: true });
  });
  const crop = normalizeCrop(clip.crop), sourceTime = clip.frozenAt ?? clip.sourceStart + clamp(time - clip.start, 0, clipDuration(clip) - .001) * clip.speed;
  try {
    if (element instanceof HTMLVideoElement) {
      element.muted = true; element.playsInline = true; element.preload = "auto";
      const loaded = wait("loadeddata"); element.src = asset.url; await loaded;
      const at = clamp(sourceTime, 0, Math.max(0, element.duration - .002));
      if (Math.abs(element.currentTime - at) > .001) { const seek = wait("seeked"); element.currentTime = at; await seek; }
    } else { const loaded = wait("load"); element.src = asset.url; await loaded; }
    if (signal.aborted) throw cancelled();
    const width = element instanceof HTMLVideoElement ? element.videoWidth : element.naturalWidth;
    const height = element instanceof HTMLVideoElement ? element.videoHeight : element.naturalHeight;
    const scale = Math.min(1, 640 / Math.max(width * crop.width, height * crop.height));
    const canvas = document.createElement("canvas"); canvas.width = Math.max(1, Math.round(width * crop.width * scale)); canvas.height = Math.max(1, Math.round(height * crop.height * scale));
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!; ctx.drawImage(element, width * crop.x, height * crop.y, width * crop.width, height * crop.height, 0, 0, canvas.width, canvas.height);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const result = { pixels, width: canvas.width, height: canvas.height, image: canvas.toDataURL("image/jpeg", .85), crop, sourceTime };
    canvas.width = canvas.height = 0; return result;
  } finally { if (element instanceof HTMLVideoElement) { element.pause(); element.removeAttribute("src"); element.load(); } else element.src = ""; }
}
export function ObjectDetectionControls({ clip, asset, project, time, apply }: {
  clip: Clip; asset: Asset; project: Project; time: number; apply: (patch: Partial<Clip>, clearKeys?: string[]) => void;
}) {
  const worker = useRef<Worker | null>(null), abort = useRef<AbortController | null>(null), generation = useRef(0);
  const [busy, setBusy] = useState(false), [status, setStatus] = useState(""), [error, setError] = useState("");
  const [analysis, setAnalysis] = useState<Analysis | null>(null), [selection, setSelection] = useState(0), [threshold, setThreshold] = useState(.35);
  const [consented, setConsented] = useState(false), [asking, setAsking] = useState(false);
  const signature = sourceSignature(clip, asset);
  const cancel = () => { generation.current++; abort.current?.abort(); worker.current?.terminate(); worker.current = null; setBusy(false); setStatus("Cancelled. You can retry whenever you like."); };
  useEffect(() => () => { generation.current++; abort.current?.abort(); worker.current?.terminate(); }, [signature]);
  const result = analysis?.signature === signature ? analysis : null;
  const objects = result?.objects.filter((object) => object.score >= threshold) ?? [], object = objects[Math.min(selection, Math.max(0, objects.length - 1))];
  const detect = async () => {
    const token = ++generation.current, controller = new AbortController(); abort.current = controller;
    setBusy(true); setError(""); setStatus("Reading the selected source frame…"); setAsking(false);
    try {
      const frame = await captureSource(clip, asset, time, controller.signal);
      if (token !== generation.current) return;
      const { default: DetectorWorker } = await import("./objectDetection.worker?worker");
      if (token !== generation.current) return;
      worker.current ??= new DetectorWorker(); const active = worker.current;
      const detected = await new Promise<DetectedObject[]>((resolve, reject) => {
        const timer = setTimeout(() => { stop(); reject(new Error("The detector took too long. Cancel and retry; a first download needs internet access.")); }, 240000);
        const stop = () => { clearTimeout(timer); controller.signal.removeEventListener("abort", abortJob); active.onmessage = active.onerror = active.onmessageerror = null; };
        const abortJob = () => { stop(); reject(cancelled()); }; controller.signal.addEventListener("abort", abortJob, { once: true });
        active.onmessage = (e: MessageEvent<{ type: string; objects?: unknown; message?: string; progress?: number }>) => {
          if (e.data.type === "done") { stop(); resolve(normalizeDetections(e.data.objects, .25)); }
          else if (e.data.type === "error") { stop(); reject(new Error(e.data.message)); }
          else if (token === generation.current) setStatus(e.data.type === "progress" ? `Downloading detector · ${Math.round(e.data.progress ?? 0)}%` : e.data.message ?? "Analyzing…");
        };
        active.onerror = (e) => { stop(); reject(new Error(e.message || "The local detector could not start. Retry after checking the model download.")); };
        active.onmessageerror = () => { stop(); reject(new Error("Unreadable detector response. Please retry.")); };
        active.postMessage({ pixels: frame.pixels, width: frame.width, height: frame.height, runtimeUrl: new URL("./whisper-runtime/", document.baseURI).href }, [frame.pixels.buffer]);
      });
      if (token === generation.current) { setAnalysis({ ...frame, objects: detected, clipId: clip.id, signature }); setSelection(0); setStatus(detected.length ? `${detected.length} objects found in this frame.` : "No familiar objects found. Try a different frame or lower the confidence filter."); }
    } catch (e) {
      if (token === generation.current && !(e instanceof DOMException && e.name === "AbortError")) { setError(e instanceof Error ? e.message : String(e)); worker.current?.terminate(); worker.current = null; }
    } finally { if (token === generation.current) setBusy(false); }
  };
  return <section className="object-detection"><div className="object-heading"><ScanSearch size={16} /><div><h3>Find objects</h3><span>Private, on-device analysis</span></div></div>
    <p className="field-note">Detect people and common objects in the source frame at the playhead. Select a result to create a crop or an editable rectangular mask.</p>
    {!busy && <button type="button" className="button detect-button" disabled={!asset.url} onClick={() => { if (!consented) setAsking(true); else void detect(); }}><ScanSearch size={15} />{result ? "Analyze another frame" : "Detect objects"}</button>}
    {asking && <div className="detector-consent"><Download size={17} /><strong>Free local detector</strong><p>The first run downloads YOLOS Tiny (about 10 MB of model weights). It is cached on this device. No account, API key, payment or footage upload.</p>
      <div><button type="button" className="button" onClick={() => setAsking(false)}>Cancel</button><button type="button" className="button primary" onClick={() => { setConsented(true); void detect(); }}>Download & detect</button></div></div>}
    {busy && <div className="detection-progress" role="status"><span className="detection-spinner" /><span>{status}</span><button type="button" className="icon-button" aria-label="Cancel object detection" onClick={cancel}><X size={14} /></button></div>}
    {!busy && status && <p className="field-note" role="status">{status}</p>}{error && <p className="detection-error" role="alert">{error}</p>}
    {result && <><div className="detection-image" style={{ aspectRatio: result.width / result.height }}><img src={result.image} alt="Source frame analyzed locally" />
      {objects.map((item, i) => <button type="button" key={i} className={object === item ? "active" : ""} title={`${item.label} · ${Math.round(item.score * 100)}% confidence`} aria-label={`Select ${item.label} ${i + 1}`}
        onClick={() => setSelection(i)} style={{ left: `${item.box.xmin * 100}%`, top: `${item.box.ymin * 100}%`, width: `${(item.box.xmax - item.box.xmin) * 100}%`, height: `${(item.box.ymax - item.box.ymin) * 100}%` }}><span>{item.label}</span></button>)}</div>
      <div className="detection-confidence"><label htmlFor="object-confidence">Confidence</label><input id="object-confidence" aria-label="Object confidence" type="range" min={.25} max={.95} step={.05} value={threshold} onChange={(e) => { setThreshold(Number(e.target.value)); setSelection(0); }} /><span>{Math.round(threshold * 100)}%</span></div>
      <div className="detected-objects" role="group" aria-label="Detected objects">{objects.map((item, i) => <button type="button" key={i} aria-pressed={object === item} onClick={() => setSelection(i)}><span>{item.label}</span><small>{Math.round(item.score * 100)}%</small></button>)}</div>
      {object && <div className="detection-actions"><button type="button" className="button" onClick={() => {
        const mask: VisualCompositing = detectionMask(object, result, dimensions(project.ratio, 1080), clip.fit);
        apply(mask, Object.keys(mask));
      }}><Scan size={13} />Mask object</button><button type="button" className="button" onClick={() => {
        apply({ crop: detectionCrop(object, result.crop), fit: "contain", fitExplicit: true }, ["fit"]);
      }}><Crop size={13} />Crop to object</button></div>}
      <p className="field-note">Source {result.sourceTime.toFixed(2)}s · bounding boxes, not pixel-perfect cutout or motion tracking. Mask object replaces the existing mask and its keyframes. Objects outside the fitted frame may be hidden.</p></>}
  </section>;
}
