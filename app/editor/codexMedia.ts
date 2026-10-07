import { loadMediaAsset } from "../editorStorage";
import { beatTimes, DEFAULT_BEAT_SETTINGS, type BeatAnalysis } from "./beatDetection";
import { audioLevels, audioTiming, audioWindow } from "./codexMediaData";
import type { CodexImage } from "./codexTypes";
import type { Asset, Clip } from "./model";
import { decodeClipAudio, type WhisperChunk } from "./whisper";

export const SPEECH_MODELS = [
  { id: "Xenova/whisper-tiny", name: "Tiny · multilingual · CPU", size: "50–100 MB" },
  { id: "Xenova/whisper-tiny.en", name: "Tiny · English · CPU", size: "50–100 MB" },
  { id: "onnx-community/whisper-large-v3-ONNX", name: "Large v3 · multilingual · GPU", size: "~1 GB · WebGPU required" },
];
const check = (signal: AbortSignal) => { signal.throwIfAborted(); };

function waitMedia(target: HTMLImageElement | HTMLVideoElement, event: string, signal: AbortSignal, begin: () => void) {
  return new Promise<void>((resolve, reject) => {
    const done = (error?: Error | DOMException) => {
      clearTimeout(timer); target.removeEventListener(event, loaded); target.removeEventListener("error", failed); signal.removeEventListener("abort", cancelled);
      if (error) reject(error); else resolve();
    };
    const loaded = () => done(), failed = () => done(new Error("Could not read this source image or video. Relink the media and try again."));
    const cancelled = () => done(new DOMException("Media inspection cancelled", "AbortError"));
    const timer = setTimeout(() => done(new Error("The source media took too long to load.")), 20000);
    target.addEventListener(event, loaded, { once: true }); target.addEventListener("error", failed, { once: true }); signal.addEventListener("abort", cancelled, { once: true });
    if (signal.aborted) cancelled(); else { try { begin(); } catch (error) { done(error as Error); } }
  });
}

function boundedImage(source: CanvasImageSource, width: number, height: number) {
  if (!(width > 0 && height > 0)) throw new Error("This image has no readable dimensions.");
  const ratio = Math.min(1, 1024 / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * ratio)); canvas.height = Math.max(1, Math.round(height * ratio));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Image capture is not available.");
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  // PNG preserves transparency in source images and stays bounded at 1024 px.
  let imageUrl = canvas.toDataURL("image/png");
  if (imageUrl.length > 1900000) imageUrl = canvas.toDataURL("image/webp", .85);
  if (imageUrl.length > 2000000) throw new Error("This image is too complex to attach. Try a smaller reference.");
  return { imageUrl, width: canvas.width, height: canvas.height, originalWidth: width, originalHeight: height };
}

export async function referenceImage(file: File, signal: AbortSignal): Promise<CodexImage> {
  if (!/\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(file.name) || file.size > 25 * 1024 * 1024) throw new Error("Choose a PNG, JPEG, WebP, GIF, BMP or AVIF image under 25 MB.");
  const url = URL.createObjectURL(file), image = new Image();
  try {
    await waitMedia(image, "load", signal, () => { image.src = url; }); check(signal);
    return { name: file.name.slice(0, 200), imageUrl: boundedImage(image, image.naturalWidth, image.naturalHeight).imageUrl };
  } finally { image.src = ""; URL.revokeObjectURL(url); }
}

export async function captureSource(asset: Asset, sourceTime: number, signal: AbortSignal) {
  if (asset.kind !== "image" && asset.kind !== "video") throw new Error("Choose an imported image or video asset, not audio.");
  check(signal);
  const saved = await loadMediaAsset(asset.id); check(signal);
  const owned = saved?.blob ? URL.createObjectURL(saved.blob) : null, url = owned ?? asset.url;
  if (!url) throw new Error("The source media is missing. Relink or import it again.");
  const media = asset.kind === "image" ? new Image() : document.createElement("video");
  try {
    if (media instanceof HTMLVideoElement) {
      media.muted = true; media.preload = "auto";
      await waitMedia(media, "loadeddata", signal, () => { media.src = url; media.load(); });
      if (!Number.isFinite(media.duration) || sourceTime < 0 || sourceTime >= media.duration) throw new Error("sourceTime must be within the original video's duration, in source seconds.");
      const time = Math.min(sourceTime, Math.max(0, media.duration - .001));
      // Seek even at 0 to ensure a decoded frame, not only metadata.
      if (Math.abs(media.currentTime - time) > .0001 || media.readyState < 2) {
        await waitMedia(media, "seeked", signal, () => { media.currentTime = time; });
      }
      check(signal);
      return { ...boundedImage(media, media.videoWidth, media.videoHeight), sourceTime: time };
    }
    await waitMedia(media, "load", signal, () => { media.src = url; }); check(signal);
    return { ...boundedImage(media, media.naturalWidth, media.naturalHeight), sourceTime: null };
  } finally {
    if (media instanceof HTMLVideoElement) { media.pause(); media.removeAttribute("src"); media.load(); }
    else media.src = "";
    if (owned) URL.revokeObjectURL(owned);
  }
}

function runWorker<T>(worker: Worker, input: unknown, samples: Float32Array, signal: AbortSignal, progress: (message: string) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const finish = (result?: T, error?: Error | DOMException) => {
      clearTimeout(timer); signal.removeEventListener("abort", cancel); worker.terminate();
      if (error) reject(error); else resolve(result!);
    };
    const cancel = () => finish(undefined, new DOMException("Audio analysis cancelled", "AbortError"));
    const timer = setTimeout(() => finish(undefined, new Error("Analysis timed out. Try a shorter window or a smaller Whisper model.")), 270000);
    signal.addEventListener("abort", cancel, { once: true });
    worker.onerror = event => finish(undefined, new Error(event.message || "The local analysis worker failed."));
    worker.onmessage = ({ data }) => {
      if (data.type === "error") finish(undefined, new Error(data.message));
      else if (data.type === "result") finish(data.result);
      else if (data.type === "done") finish(data);
      else if (data.type === "status") progress(data.message);
      else if (data.type === "progress") progress(data.file ? `Downloading Whisper · ${Math.round(data.progress ?? 0)}%` : `Analyzing rhythm · ${Math.round((data.value ?? 0) * 100)}%`);
    };
    if (signal.aborted) cancel(); else { try { worker.postMessage(input, [samples.buffer as ArrayBuffer]); } catch (error) { finish(undefined, error as Error); } }
  });
}

export async function analyzeClipAudio(clip: Clip, asset: Asset, args: { mode: "rhythm" | "speech"; offset?: number; duration?: number }, speechModel: string, signal: AbortSignal, progress: (message: string) => void) {
  if (asset.kind !== "audio" && asset.kind !== "video") throw new Error("Select a clip with audio or video media.");
  const window = audioWindow(clip, args.offset, args.duration);
  progress("Decoding local audio…");
  const samples = await decodeClipAudio(window, asset, { signal, maxDuration: 120 }); check(signal);
  const levels = audioLevels(samples);
  const metadata = {
    clipId: clip.id, assetId: asset.id, mode: args.mode, offset: args.offset ?? 0, duration: samples.length / 16000,
    start: audioTiming(window, 0), speed: clip.speed, sampleRate: 16000,
    scope: "Selected source audio after trim and playback speed, before volume, effects, fades or mixing. No raw audio is sent. Timestamps include source and timeline seconds. Estimates are not semantic hearing.",
    levels: { ...levels, silence: levels.silence.map(interval => ({ start: audioTiming(window, interval.start), end: audioTiming(window, interval.end) })) },
  };
  if (args.mode === "rhythm") {
    const worker = new Worker(new URL("./beatDetection.worker.ts", import.meta.url), { type: "module" });
    const analysis = await runWorker<BeatAnalysis>(worker, { samples }, samples, signal, progress); check(signal);
    return { ...metadata, bpm: analysis.bpm, confidence: analysis.confidence, beats: beatTimes(analysis, DEFAULT_BEAT_SETTINGS).slice(0, 1000).map(time => audioTiming(window, time)), onsets: analysis.peaks.slice(0, 1000).map(peak => ({ ...audioTiming(window, peak.time), strength: peak.strength })), note: "Tempo and onsets are approximate; inspect confidence before synchronizing cuts. No instruments or mood are inferred." };
  }
  if (!SPEECH_MODELS.some(model => model.id === speechModel)) throw new Error("Choose an available local Whisper model.");
  if (speechModel.includes("large") && !("gpu" in navigator)) throw new Error("Large v3 needs WebGPU. Use Tiny on this PC.");
  const worker = new Worker(new URL("./whisper.worker.ts", import.meta.url), { type: "module" });
  const output = await runWorker<{ chunks: WhisperChunk[]; text: string }>(worker, { audio: samples, model: speechModel, runtimeUrl: new URL("./whisper-runtime/", document.baseURI).href }, samples, signal, progress); check(signal);
  return { ...metadata, model: speechModel, transcript: output.text.slice(0, 20000), segments: output.chunks.filter(chunk => Number.isFinite(chunk.timestamp?.[0])).slice(0, 2000).map(chunk => ({ text: chunk.text.slice(0, 1000), start: audioTiming(window, chunk.timestamp[0]), end: chunk.timestamp[1] === null ? null : audioTiming(window, chunk.timestamp[1]) })), note: "Speech recognition runs locally and can make mistakes, especially on music or silence. Transcript and timing metadata, not raw audio, are sent to Codex." };
}
