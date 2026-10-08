import { loadMediaAsset } from "../editorStorage";
import { clipDuration, roundFrame, type Asset, type Clip } from "./model";
import { findSceneCuts, sceneDifference, sceneFingerprint, type SceneCut, type SceneFrame, type SceneSettings } from "./sceneDetection";

function waitVideo(video: HTMLVideoElement, event: string, signal: AbortSignal, begin: () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer); video.removeEventListener(event, loaded); video.removeEventListener("error", failed); signal.removeEventListener("abort", cancelled);
      if (error) reject(error); else resolve();
    };
    const loaded = () => finish(), failed = () => finish(new Error("This video could not be decoded. Relink it or convert it to MP4/WebM."));
    const cancelled = () => finish(new DOMException("Scene scan cancelled", "AbortError"));
    const timer = setTimeout(() => finish(new Error("Video decoding timed out. Try a shorter clip or another format.")), 15000);
    video.addEventListener(event, loaded, { once: true }); video.addEventListener("error", failed, { once: true }); signal.addEventListener("abort", cancelled, { once: true });
    if (signal.aborted) cancelled(); else { try { begin(); } catch (error) { finish(error as Error); } }
  });
}

/** Scan original trimmed footage, not overlays/effects. A separate decoder never moves the player. */
export async function scanScenes(clip: Clip, asset: Asset, fps: number, settings: SceneSettings, signal: AbortSignal, progress: (value: number) => void): Promise<SceneCut[]> {
  signal.throwIfAborted();
  if (asset.kind !== "video" || clip.kind !== "video" || clip.frozenAt !== undefined) throw new Error("Select a moving video clip, not an image, audio or freeze frame.");
  const duration = clipDuration(clip);
  if (duration > 600) throw new Error("Scan up to 10 minutes at a time. Split or trim this clip first.");
  if (duration < .25) throw new Error("This clip is too short to scan. Use a manual split instead.");
  const saved = await loadMediaAsset(asset.id); signal.throwIfAborted();
  const ownedUrl = saved?.blob ? URL.createObjectURL(saved.blob) : undefined, url = ownedUrl ?? asset.url;
  if (!url) throw new Error("Source video is missing. Relink or import it again.");
  const video = document.createElement("video"), canvas = document.createElement("canvas");
  canvas.width = 160; canvas.height = 90;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  video.muted = true; video.preload = "auto"; video.playsInline = true;
  try {
    if (!ctx) throw new Error("Frame analysis is unavailable on this device.");
    await waitVideo(video, "loadeddata", signal, () => { video.src = url; video.load(); });
    if (!(video.videoWidth > 0 && video.videoHeight > 0)) throw new Error("This video has no readable frames.");
    const scale = Math.min(160 / video.videoWidth, 90 / video.videoHeight);
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale)); canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    if (!Number.isFinite(video.duration) || clip.sourceEnd > video.duration + .1) throw new Error("The source duration changed. Reimport the video before scanning.");
    const capture = async (localTime: number): Promise<SceneFrame> => {
      signal.throwIfAborted();
      const time = Math.min(video.duration - .001, clip.sourceStart + localTime * clip.speed);
      if (Math.abs(video.currentTime - time) > .00001 || video.readyState < 2) await waitVideo(video, "seeked", signal, () => { video.currentTime = time; });
      signal.throwIfAborted(); ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      return sceneFingerprint(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, localTime);
    };
    const step = 1 / Math.min(8, fps), frames: SceneFrame[] = [];
    for (let time = 0; time < duration - .0001; time += step) {
      frames.push(await capture(time)); progress(.8 * time / duration);
    }
    // Include a final lookahead so cuts near the end can be confirmed.
    const finalTime = Math.max(0, duration - .001 / clip.speed);
    if (finalTime > frames.at(-1)!.time + .0001) frames.push({ ...await capture(finalTime), time: duration });
    const candidates = findSceneCuts(frames, settings);
    if (candidates.length > 300) throw new Error("Over 300 changes detected. Lower sensitivity or scan a shorter clip.");
    const cuts: SceneCut[] = [];
    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index];
      let low = Math.max(0, candidate.time - step), high = candidate.time;
      const left = await capture(low), right = await capture(high);
      // Locate the actual hard cut inside the sampled interval, to a project-frame boundary.
      while (high - low > 1 / fps / 2) {
        const mid = (low + high) / 2, frame = await capture(mid);
        if (sceneDifference(left, frame) < sceneDifference(right, frame)) low = mid; else high = mid;
      }
      const time = roundFrame((low + high) / 2, fps);
      if (time < 1 / fps || duration - time < 1 / fps || cuts.some(cut => Math.abs(cut.time - time) < 1 / fps)) continue;
      await capture(Math.max(0, time - 1 / fps)); const before = canvas.toDataURL("image/jpeg", .65);
      await capture(Math.min(duration - 1 / fps, time)); const after = canvas.toDataURL("image/jpeg", .65);
      cuts.push({ ...candidate, time, before, after }); progress(.8 + .2 * (index + 1) / candidates.length);
    }
    progress(1); return cuts;
  } finally {
    video.pause(); video.removeAttribute("src"); video.load(); if (ownedUrl) URL.revokeObjectURL(ownedUrl);
  }
}
