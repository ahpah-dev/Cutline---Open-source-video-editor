import {
  clamp,
  projectDuration,
  transitionWindow,
  uid,
  type Asset,
  type Project,
} from "./model";
import type { MediaSources } from "./renderer";
import { analyzeAudioWaveform } from "./waveform";
import { ensureTextFonts } from "./textFonts";
import type { ExportOptions, ExportSink } from "./offlineExport";
import { mediaToTimeline, previewMediaStates, PreviewClock } from "./previewPlayback";

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
  private positions = new Map<string, { target: number; promise: Promise<void> }>();
  private plays = new Map<string, Promise<void>>();
  private playbackGeneration = 0;
  private transport: { clock: PreviewClock; ready: boolean; blocked: boolean; master: string | null } | null = null;
  get playbackReady() { return this.transport?.ready ?? false; }
  get playbackBuffering() { return !!this.transport && (!this.transport.ready || this.transport.blocked); }
  get previewSeeking() { return this.positions.size > 0; }
  private clockNow() { return this.context?.currentTime ?? performance.now()/1000; }
  /** Latest target wins, including when another seek is still decoding. */
  private position(id: string, element: HTMLMediaElement, target: number) {
    const existing = this.positions.get(id);
    if (existing) { existing.target = target; return existing.promise; }
    if (!element.seeking && Math.abs(element.currentTime-target) <= .008) return null;
    const controller = this.controllers.get(id);
    const job = { target, promise: Promise.resolve() };
    this.positions.set(id, job);
    job.promise = (async () => {
      // Reserve before starting: rapid scrubs share one seek loop, not dozens
      // of listeners/promises which can later resume an obsolete position.
      await Promise.resolve();
      while (!this.disposed && this.elements.get(id) === element && !controller?.signal.aborted) {
        if (element.seeking) await ready(element,"seeked",10000,controller?.signal);
        if (Math.abs(element.currentTime-job.target) <= .008) return;
        const sought = ready(element,"seeked",10000,controller?.signal);
        element.currentTime = job.target;
        await sought;
      }
    })().catch(error => { if ((error as Error).name !== "AbortError") throw error; }).finally(() => {
      if (this.positions.get(id) === job) this.positions.delete(id);
    });
    return job.promise;
  }
  async startPlayback(project: Project, time: number, beforePlay?: () => void | Promise<void>) {
    this.pause();
    const generation = this.playbackGeneration;
    const transport = { clock: new PreviewClock(time,this.clockNow()), ready: false, blocked: true, master: null as string | null };
    this.transport = transport;
    try {
      await Promise.all([this.enableAudio(),this.ensure(project)]);
      if (generation !== this.playbackGeneration || this.disposed) return false;
      await this.sync(project,time,false);
      if (generation !== this.playbackGeneration || this.disposed) return false;
      await beforePlay?.();
      if (generation !== this.playbackGeneration || this.disposed) return false;
      await this.sync(project,time,true);
      if (generation !== this.playbackGeneration || this.disposed) return false;
      // Unmute only once every active play() promise has actually resolved.
      await this.sync(project,time,true);
      if (generation !== this.playbackGeneration || this.disposed) return false;
      transport.ready = true;
      transport.clock.sample(this.clockNow(),undefined,true);
      return true;
    } catch(error) {
      if (generation !== this.playbackGeneration || this.disposed) return false;
      this.pause(); throw error;
    }
  }
  playbackTime(project: Project) {
    const transport = this.transport;
    if (!transport) return null;
    const now = this.clockNow();
    if (!transport.ready) return transport.clock.sample(now,undefined,true);
    const states = previewMediaStates(project,transport.clock.time).filter(state => state.clip.frozenAt === undefined && this.elements.has(state.clip.id));
    const candidates = states.filter(state => !this.elements.get(state.clip.id)!.ended);
    const master = candidates.find(state => state.clip.id === transport.master) ??
      candidates.find(state => state.clip.kind === "audio" && state.volume > 0) ?? candidates.find(state => state.volume > 0) ?? candidates[0];
    transport.master = master?.clip.id ?? null;
    const element = master ? this.elements.get(master.clip.id)! : null;
    const blocked = this.positions.size > 0 || this.plays.size > 0 || this.context?.state === "suspended" || !!element && (element.paused || element.seeking || element.readyState < 2);
    // An overdue RAF in a silent gap must stop at the next source, not jump
    // over an entire short clip before it has ever had a chance to play.
    const nextStart = Math.min(Infinity,...project.clips.filter(clip => clip.frozenAt === undefined && this.elements.has(clip.id))
      .map(clip => Math.max(0,transitionWindow(project,clip)?.start ?? clip.start)).filter(start => start > transport.clock.time+.000001));
    return transport.clock.sample(now,element && master ? Math.min(master.end,Math.max(master.start,mediaToTimeline(master.clip,element.currentTime))) : undefined,blocked,nextStart);
  }
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
    const states = previewMediaStates(project,time);
    const active = new Set(states.map(state => state.clip.id));
    for (const [id,el] of this.elements) if (!active.has(id)) {
      el.pause();
      const gain = this.gains.get(id);
      if (gain) this.setAudioValue(gain.gain,0,false);
    }
    for (const {clip:c} of states) {
      const el = this.elements.get(c.id); if (!el) continue;
      const asset = project.assets.find(a => a.id === c.assetId);
      const sourceTime = clamp(
        c.frozenAt ?? (c.sourceStart + (time - c.start) * c.speed),
        0,
        Math.max(0, (asset?.duration ?? el.duration) - 0.002),
      );
      el.playbackRate = c.speed;
      if (this.positions.has(c.id) || el.seeking || Math.abs(el.currentTime-sourceTime) > (playing ? .04*c.speed : .008)) {
        const positioned = this.position(c.id,el,sourceTime);
        if (positioned) seeks.push(positioned);
      }
    }
    // A decoder seek pauses the whole transport, not just one audible layer.
    // Otherwise another song keeps playing while the playhead waits for video.
    const waitingForData = playing && (this.context?.state === "suspended" || states.some(({clip}) => {
      const element = this.elements.get(clip.id);
      return clip.frozenAt === undefined && !!element && element.readyState < 2;
    }));
    if (playing && (seeks.length || waitingForData)) {
      for (const el of this.elements.values()) el.pause();
    }
    const starts: Promise<void>[] = [];
    const generation = this.playbackGeneration;
    for (const {clip:c} of states) {
      const el = this.elements.get(c.id); if (!el) continue;
      const asset = project.assets.find(a => a.id === c.assetId);
      const exhausted = el.ended && el.currentTime >= Math.max(0,el.duration-.01);
      if (playing && !seeks.length && !waitingForData && c.frozenAt === undefined && !exhausted) {
        let playback = this.plays.get(c.id);
        if (!playback && el.paused) {
          playback = el.play().catch(error => {
            if ((error as Error).name === "AbortError" || this.disposed || generation !== this.playbackGeneration) return;
            throw new Error(`Could not start playback of “${asset?.name ?? c.label}”: ${(error as Error).message}`);
          }).finally(() => {
            if (this.plays.get(c.id) === playback) this.plays.delete(c.id);
          });
          this.plays.set(c.id,playback);
        }
        if (playback) starts.push(playback);
      }
      if (!playing || c.frozenAt !== undefined) el.pause();
    }
    const blocked = playing && (waitingForData || seeks.length > 0 || starts.length > 0);
    if (this.transport) this.transport.blocked = blocked;
    for (const {clip:c,volume,pan:panValue} of states) {
      const gain = this.gains.get(c.id);
      if (gain) {
        this.setAudioValue(gain.gain,blocked ? 0 : volume,playing && !blocked);
      }
      const pan = this.pans.get(c.id);
      if (pan) this.setAudioValue(pan.pan,panValue,playing && !blocked);
    }
    return Promise.all([...seeks,...starts]);
  }
  pause() {
    this.playbackGeneration++;
    this.transport = null;
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
    this.positions.delete(id);
    this.plays.delete(id);
    this.sources.delete(id);
    this.revision++;
    this.urls.delete(id);
    this.pending.delete(id);
  }
  dispose() {
    this.pause();
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
      typeof VideoEncoder !== "undefined" &&
      (typeof MediaRecorder === "undefined" || MediaRecorder.isTypeSupported(f.mime)),
  );

export function exportProject(project: Project, options: ExportOptions & {sink:ExportSink}): Promise<number>;
export function exportProject(project: Project, options: ExportOptions): Promise<Blob>;
export async function exportProject(
  project: Project,
  options: ExportOptions & {sink?:ExportSink},
) {
  const { signal } = options;
  const check = () => {
    if (signal.aborted)
      throw new DOMException("Export cancelled", "AbortError");
  };
  check();
  if (!Number.isFinite(options.resolution) || options.resolution < 144 || options.resolution > 4320 ||
      !Number.isFinite(options.fps) || options.fps < 1 || options.fps > 120)
    throw new Error("Choose a supported resolution and frame rate before exporting.");
  if (typeof VideoEncoder === "undefined" || !exportFormats().some(format=>format.mime===options.mime))
    throw new Error("Frame-accurate export is unavailable. Use the Windows app or a current Chromium browser in a secure context.");
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
  const { renderOffline } = await import("./offlineExport");
  check();
  return options.sink ? renderOffline(project,{...options,sink:options.sink}) : renderOffline(project,options);
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
