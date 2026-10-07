import {
  animatedItem,
  clamp,
  dimensions,
  endOf,
  projectDuration,
  trackKey,
  transitionWindow,
  uid,
  type Asset,
  type Project,
} from "./model";
import { Renderer, type MediaSources } from "./renderer";
import { analyzeAudioWaveform } from "./waveform";
import { ensureTextFonts } from "./textFonts";

function ready(element: HTMLMediaElement, event: string, timeout = 20000, signal?: AbortSignal) {
  if (signal?.aborted) return Promise.reject(new DOMException("Media loading cancelled", "AbortError"));
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      element.removeEventListener(event, done);
      element.removeEventListener("error", fail);
      signal?.removeEventListener("abort", aborted);
    };
    const done = () => {
      cleanup();
      resolve();
    };
    const fail = () => {
      cleanup();
      reject(
        new Error(
          "This media could not be decoded. Try H.264 MP4, WebM, MP3, WAV, or a standard image.",
        ),
      );
    };
    const aborted = () => {
      cleanup();
      reject(new DOMException("Media loading cancelled", "AbortError"));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          "Media took too long to load. The file may be damaged or unsupported.",
        ),
      );
    }, timeout);
    element.addEventListener(event, done, { once: true });
    element.addEventListener("error", fail, { once: true });
    signal?.addEventListener("abort", aborted, { once: true });
  });
}
export async function inspectFile(file: File): Promise<Asset> {
  const extension = file.name.split(".").at(-1)?.toLowerCase() ?? "";
  const kind =
    file.type.startsWith("image/") ||
    ["png", "jpg", "jpeg", "webp", "gif", "avif"].includes(extension)
      ? "image"
      : file.type.startsWith("audio/") ||
          ["mp3", "wav", "ogg", "m4a", "flac", "aac"].includes(extension)
        ? "audio"
        : "video";
  const url = URL.createObjectURL(file);
  const asset: Asset = {
    id: uid("asset"),
    name: file.name,
    kind,
    url,
    duration: 5,
    sizeLabel:
      file.size < 1024 * 1024
        ? Math.ceil(file.size / 1024) + " KB"
        : (file.size / 1024 / 1024).toFixed(1) + " MB",
    theme: kind,
  };
  let mediaElement: HTMLMediaElement | null = null;
  try {
    if (kind === "image") {
      const img = new Image();
      img.src = url;
      await img.decode();
      asset.width = img.naturalWidth;
      asset.height = img.naturalHeight;
      const canvas = document.createElement("canvas");
      canvas.width = 240;
      canvas.height = Math.round((240 * img.naturalHeight) / img.naturalWidth);
      canvas
        .getContext("2d")!
        .drawImage(img, 0, 0, canvas.width, canvas.height);
      asset.thumbnail = canvas.toDataURL("image/jpeg", 0.7);
    } else {
      const element = document.createElement(
        kind === "audio" ? "audio" : "video",
      );
      mediaElement = element;
      element.preload = "auto";
      element.muted = true;
      const loaded = ready(element, "loadeddata");
      element.src = url;
      await loaded;
      if (!Number.isFinite(element.duration) || element.duration <= 0)
        throw new Error(
          "This file has no readable duration. Re-encode it and try again.",
        );
      asset.duration = element.duration;
      if (element instanceof HTMLVideoElement) {
        asset.width = element.videoWidth;
        asset.height = element.videoHeight;
        if (!asset.width || !asset.height)
          throw new Error("No supported video track was found in this file.");
        const canvas = document.createElement("canvas");
        canvas.width = 240;
        canvas.height = Math.max(
          1,
          Math.round((240 * element.videoHeight) / element.videoWidth),
        );
        canvas
          .getContext("2d")!
          .drawImage(element, 0, 0, canvas.width, canvas.height);
        asset.thumbnail = canvas.toDataURL("image/jpeg", 0.7);
      }
      element.removeAttribute("src");
      element.load();
      const waveform = await analyzeAudioWaveform(file);
      if (waveform) Object.assign(asset, waveform);
    }
    return asset;
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  } finally {
    if (mediaElement) {
      mediaElement.pause();
      mediaElement.removeAttribute("src");
      mediaElement.load();
    }
  }
}

export class MediaPool {
  revision = 0;
  textFontsReady = true;
  private fontPreparation = 0;
  sources: MediaSources = new Map();
  private elements = new Map<string, HTMLMediaElement>();
  private pending = new Map<string, Promise<void>>();
  private urls = new Map<string, string>();
  private gains = new Map<string, GainNode>();
  private pans = new Map<string, StereoPannerNode>();
  private nodes = new Map<string, MediaElementAudioSourceNode>();
  private controllers = new Map<string, AbortController>();
  context: AudioContext | null = null;
  destination: MediaStreamAudioDestinationNode | null = null;
  private disposed = false;
  private exporting = false;
  async ensure(project: Project) {
    if (this.disposed) return;
    // A paused preview otherwise caches the fallback-font frame indefinitely.
    const fontPreparation = ++this.fontPreparation;
    this.textFontsReady = false;
    const fontsReady = ensureTextFonts(project).then(() => {
      if (!this.disposed && fontPreparation === this.fontPreparation) {
        this.textFontsReady = true;
        this.revision++;
      }
    });
    const ids = new Set(project.clips.filter((c) => project.assets.find((a) => a.id === c.assetId)?.url).map((c) => c.id));
    for (const id of this.urls.keys()) if (!ids.has(id)) this.remove(id);
    await Promise.all(
      [fontsReady, ...project.clips.map((c) => {
        const asset = project.assets.find((a) => a.id === c.assetId);
        if (!asset?.url) return;
        if (this.urls.get(c.id) === asset.url) return this.pending.get(c.id);
        this.remove(c.id);
        const controller = new AbortController();
        this.controllers.set(c.id, controller);
        this.urls.set(c.id, asset.url);
        const promise = (async () => {
          if (asset.kind === "image") {
            const img = new Image();
            img.src = asset.url!;
            await img.decode();
            if (!this.disposed && !controller.signal.aborted && this.urls.get(c.id) === asset.url) {
              this.sources.set(c.id, img);
              this.revision++;
            }
          } else {
            const el = document.createElement(
              asset.kind === "audio" ? "audio" : "video",
            );
            el.preload = "auto";
            el.muted = true;
            if (el instanceof HTMLVideoElement) el.playsInline = true;
            this.elements.set(c.id, el);
            el.addEventListener("seeked", () => {
              if (this.elements.get(c.id) === el) this.revision++;
            });
            const loaded = ready(el, "loadeddata", 20000, controller.signal);
            el.src = asset.url!;
            await loaded;
            if (this.disposed || this.elements.get(c.id) !== el || this.urls.get(c.id) !== asset.url) return;
            if (el instanceof HTMLVideoElement) this.sources.set(c.id, el);
            this.revision++;
            this.connect(c.id, el);
          }
        })().catch((error) => {
          // Removing/replacing a source is expected while editing. Failed current
          // sources must clear their URL so a later ensure can retry them.
          if (controller.signal.aborted || this.disposed) return;
          if (this.controllers.get(c.id) === controller) this.remove(c.id);
          throw error;
        }).finally(() => {
          if (this.controllers.get(c.id) === controller) this.pending.delete(c.id);
        });
        this.pending.set(c.id, promise);
        return promise;
      })],
    );
  }
  private connect(id: string, el: HTMLMediaElement) {
    if (!this.context || this.nodes.has(id)) return;
    const node = this.context.createMediaElementSource(el),
      gain = this.context.createGain(),
      pan = this.context.createStereoPanner();
    gain.gain.value = 0;
    node.connect(gain);
    gain.connect(pan);
    pan.connect(this.destination ?? this.context.destination);
    this.nodes.set(id, node);
    this.gains.set(id, gain);
    this.pans.set(id, pan);
    el.muted = false;
  }
  async enableAudio(exporting = false) {
    if (this.disposed) return;
    this.exporting = exporting;
    if (!this.context) {
      this.context = new AudioContext();
      if (exporting)
        this.destination = this.context.createMediaStreamDestination();
      for (const [id, el] of this.elements) this.connect(id, el);
    }
    if (this.context.state === "suspended") await this.context.resume();
  }
  /** Position every source at its first used frame before real-time recording. */
  async prepareExport(project: Project) {
    await Promise.all(project.clips.map(async (clip) => {
      const el = this.elements.get(clip.id);
      if (!el) return;
      const window = transitionWindow(project, clip);
      const firstTime = Math.max(0, window?.start ?? clip.start);
      const asset = project.assets.find((a) => a.id === clip.assetId);
      const at = clamp(clip.frozenAt ?? clip.sourceStart + (firstTime - clip.start) * clip.speed, 0,
        Math.max(0, (asset?.duration ?? el.duration) - 0.002));
      if (Math.abs(el.currentTime - at) <= 0.008) return;
      const seek = ready(el, "seeked", 10000, this.controllers.get(clip.id)?.signal);
      el.currentTime = at;
      await seek;
    }));
  }
  private setAudioValue(parameter: AudioParam, value: number, smooth: boolean) {
    if (smooth && this.context) parameter.setTargetAtTime(value, this.context.currentTime, 0.004);
    else {
      if (this.context) parameter.cancelScheduledValues(this.context.currentTime);
      parameter.value = value;
    }
  }
  sync(project: Project, time: number, playing: boolean) {
    const seeks: Promise<void>[] = [];
    const joins = project.clips.flatMap((incoming) => {
      if (incoming.kind !== "video") return [];
      const window = transitionWindow(project, incoming);
      return window && time >= window.start && time < window.end ? [{ incoming, window }] : [];
    });
    for (const c of project.clips) {
      const el = this.elements.get(c.id);
      if (!el) continue;
      const asset = project.assets.find((a) => a.id === c.assetId);
      const visibleOnTrack =
        c.kind === "video"
          ? project.clips
              .filter(
                (other) =>
                  other.kind === "video" &&
                  other.track === c.track &&
                  time >= other.start &&
                  time < endOf(other),
              )
              .sort((a, b) => a.start - b.start)
              .at(-1)
          : null;
      const active =
        c.kind === "video"
          ? visibleOnTrack?.id === c.id
          : time >= c.start && time < endOf(c);
      const incomingWindow = joins.find((join) => join.incoming.id === c.id)?.window;
      const incomingMix = incomingWindow
        ? clamp((time - incomingWindow.start) / incomingWindow.duration, 0, 1) : null;
      const outgoingWindow = joins.find((join) => join.window.previous.id === c.id)?.window;
      const outgoingMix = outgoingWindow
        ? clamp((time - outgoingWindow.start) / outgoingWindow.duration, 0, 1) : null;
      const inTransition = incomingMix !== null || outgoingMix !== null;
      if (!active && !inTransition) {
        el.pause();
        const gain = this.gains.get(c.id);
        if (gain) this.setAudioValue(gain.gain, 0, false);
        continue;
      }
      const sourceTime = clamp(
        c.frozenAt ?? (c.sourceStart + (time - c.start) * c.speed),
        0,
        Math.max(0, (asset?.duration ?? el.duration) - 0.002),
      );
      el.playbackRate = c.speed;
      if (
        Math.abs(el.currentTime - sourceTime) > (playing ? 0.18 : 0.008) &&
        !el.seeking
      ) {
        const seek = ready(el, "seeked", 10000, this.controllers.get(c.id)?.signal).catch((error) => {
          if ((error as Error).name !== "AbortError") throw error;
        });
        el.currentTime = sourceTime;
        seeks.push(seek);
      }
      const animated = animatedItem(c, time);
      const audioStart = incomingMix !== null ? incomingWindow!.start : c.start;
      const audioEnd = outgoingMix !== null ? outgoingWindow!.end : endOf(c);
      const fade = Math.min(
        animated.fadeIn > 0 ? clamp((time - audioStart) / animated.fadeIn, 0, 1) : 1,
        animated.fadeOut > 0 ? clamp((audioEnd - time) / animated.fadeOut, 0, 1) : 1,
      );
      const transitionGain = incomingMix !== null ? incomingMix : outgoingMix !== null ? 1 - outgoingMix : 1;
      const gain = this.gains.get(c.id);
      if (gain) {
        const volume =
          (active || inTransition) && c.frozenAt === undefined &&
          !project.mutedTracks.includes(trackKey(c)) &&
          !project.hiddenTracks.includes(trackKey(c))
            ? animated.volume * fade * transitionGain
            : 0;
        this.setAudioValue(gain.gain, Number.isFinite(volume) ? clamp(volume, 0, 3) : 0, playing);
      }
      const pan = this.pans.get(c.id);
      if (pan) this.setAudioValue(pan.pan, clamp(Number(animated.audioPan) || 0, -1, 1), playing);
      const exhausted = el.ended && sourceTime >= Math.max(0, el.duration - 0.01);
      if (playing && (active || inTransition) && c.frozenAt === undefined && el.paused && !exhausted) {
        const playback = el.play().catch((error) => {
          if (this.exporting && !this.disposed && this.elements.get(c.id) === el)
            throw new Error(`Could not play “${asset?.name ?? c.label}” during export: ${(error as Error).message}`);
          /* Subsequent user playback can resume a blocked preview element. */
        });
        if (this.exporting) seeks.push(playback);
      }
      if (!playing || (!active && !inTransition) || c.frozenAt !== undefined) el.pause();
    }
    return Promise.all(seeks);
  }
  pause() {
    for (const el of this.elements.values()) el.pause();
    for (const gain of this.gains.values()) this.setAudioValue(gain.gain, 0, false);
  }
  private remove(id: string) {
    this.controllers.get(id)?.abort();
    this.controllers.delete(id);
    const el = this.elements.get(id);
    if (el) {
      el.pause();
      el.removeAttribute("src");
      el.load();
    }
    this.nodes.get(id)?.disconnect();
    this.gains.get(id)?.disconnect();
    this.pans.get(id)?.disconnect();
    this.nodes.delete(id);
    this.gains.delete(id);
    this.pans.delete(id);
    this.elements.delete(id);
    this.sources.delete(id);
    this.revision++;
    this.urls.delete(id);
    this.pending.delete(id);
  }
  dispose() {
    this.disposed = true;
    for (const id of [...this.urls.keys()]) this.remove(id);
    if (this.context && this.context.state !== "closed") void this.context.close().catch(() => {});
    this.context = null;
    this.destination = null;
  }
}

export const exportFormats = () =>
  [
    {
      label: "MP4 · H.264",
      extension: "mp4",
      mime: "video/mp4;codecs=avc1.42001f,mp4a.40.2",
    },
    {
      label: "WebM · VP9",
      extension: "webm",
      mime: "video/webm;codecs=vp9,opus",
    },
    {
      label: "WebM · VP8",
      extension: "webm",
      mime: "video/webm;codecs=vp8,opus",
    },
  ].filter(
    (f) =>
      typeof MediaRecorder !== "undefined" &&
      MediaRecorder.isTypeSupported(f.mime),
  );

export async function exportProject(
  project: Project,
  options: {
    resolution: number;
    fps: number;
    mime: string;
    signal: AbortSignal;
    onProgress: (progress: number, phase: string) => void;
  },
) {
  const { signal, onProgress } = options;
  const check = () => {
    if (signal.aborted)
      throw new DOMException("Export cancelled", "AbortError");
  };
  check();
  if (!Number.isFinite(options.resolution) || options.resolution < 144 || options.resolution > 4320 ||
      !Number.isFinite(options.fps) || options.fps < 1 || options.fps > 120)
    throw new Error("Choose a supported resolution and frame rate before exporting.");
  if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported(options.mime))
    throw new Error("This video format is unavailable. Choose one of the supported export formats.");
  const duration = projectDuration(project);
  const missing = project.clips
    .map((c) => project.assets.find((a) => a.id === c.assetId))
    .find((a) => !a || (a.kind !== "demo" && !a.url));
  if (
    project.clips.some(
      (c) => !project.assets.some((a) => a.id === c.assetId),
    ) ||
    missing
  )
    throw new Error(
      "A clip’s source media is missing. Restore a project backup with its media before exporting.",
    );
  if (duration <= 0)
    throw new Error("Add a video, audio, or text clip before exporting.");
  const canvas = document.createElement("canvas");
  Object.assign(canvas, dimensions(project.ratio, options.resolution));
  const renderer = new Renderer(),
    pool = new MediaPool();
  let recorder: MediaRecorder | null = null,
    stream: MediaStream | null = null;
  let frame = 0;
  let rejectAbort: (error: DOMException) => void = () => {};
  const aborted = () => rejectAbort(new DOMException("Export cancelled", "AbortError"));
  const abortPromise = new Promise<never>((_, reject) => {
    rejectAbort = reject;
    signal.addEventListener("abort", aborted, { once: true });
  });
  // Handle cancellation even during loading, and keep all recorders and tracks scoped to this export.
  try {
    onProgress(0, "Preparing media");
    await Promise.race([pool.ensure(project), abortPromise]);
    check();
    await Promise.race([document.fonts.ready, abortPromise]);
    await Promise.race([pool.prepareExport(project), abortPromise]);
    await Promise.race([pool.enableAudio(true), abortPromise]);
    await Promise.race([pool.sync(project, 0, false), abortPromise]);
    check();
    renderer.draw(canvas, project, 0, pool.sources);
    // Request explicit captures at the chosen frame rate, including unchanged
    // still-image/text frames that automatic canvas capture may omit.
    stream = canvas.captureStream(options.fps);
    const videoTrack = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
    for (const track of pool.destination?.stream.getAudioTracks() ?? [])
      stream.addTrack(track);
    recorder = new MediaRecorder(stream, {
      mimeType: options.mime,
      videoBitsPerSecond:
        options.resolution >= 2160
          ? 24000000
          : options.resolution >= 1080
            ? 10000000
            : 5000000,
      audioBitsPerSecond: 192000,
    });
    const chunks: Blob[] = [];
    const stopped = new Promise<void>((resolve, reject) => {
      recorder!.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };
      recorder!.onstop = () => resolve();
      recorder!.onerror = () =>
        reject(new Error("The encoder failed. Try 720p or the WebM format."));
    });
    recorder.start(250);
    const started = performance.now();
    let capturedFrame = -1;
    const render = new Promise<void>((resolve, reject) => {
      const tick = () => {
        try {
          check();
          const elapsed = Math.min(duration, (performance.now() - started) / 1000);
          void pool.sync(project, Math.min(elapsed, duration - 0.001), true).catch(reject);
          const frameIndex = Math.min(Math.ceil(duration * options.fps) - 1, Math.floor(elapsed * options.fps));
          if (frameIndex !== capturedFrame) {
            renderer.draw(canvas, project, Math.min(elapsed, duration - 0.001), pool.sources);
            videoTrack.requestFrame?.();
            capturedFrame = frameIndex;
          }
          onProgress(elapsed / duration, "Rendering your video");
          if (elapsed >= duration) resolve();
          else frame = requestAnimationFrame(tick);
        } catch (error) { reject(error); }
      };
      tick();
    });
    await Promise.race([
      render,
      stopped.then(() => {
        throw new Error("The encoder stopped before the video was finished.");
      }),
      abortPromise,
    ]);
    pool.pause();
    onProgress(1, "Finishing video");
    recorder.stop();
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([stopped, abortPromise, new Promise<never>((_, reject) => {
        flushTimer = setTimeout(() => reject(new Error("The encoder could not finish the video. Try a lower resolution or another format.")), 30000);
      })]);
    } finally { clearTimeout(flushTimer); }
    check();
    const blob = new Blob(chunks, { type: options.mime });
    if (!blob.size)
      throw new Error(
        duration < 1 ? "The encoder could not finish this very short video. Extend the edit to at least 2 seconds and retry."
          : "The encoder produced an empty video. Try another format.",
      );
    onProgress(1, "Video ready");
    return blob;
  } finally {
    signal.removeEventListener("abort", aborted);
    cancelAnimationFrame(frame);
    pool.dispose();
    renderer.dispose();
    if (recorder && recorder.state !== "inactive") {
      try { recorder.stop(); } catch { /* Preserve the original cancellation or encoder failure. */ }
    }
    stream?.getTracks().forEach((track) => track.stop());
  }
}

export async function saveBlob(blob: Blob, name: string) {
  if (window.cutlineDesktop)
    return !(
      await window.cutlineDesktop.saveFile(name, await blob.arrayBuffer())
    ).canceled;
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return true;
}
