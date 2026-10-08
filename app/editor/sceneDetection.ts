import { clipDuration, roundFrame, splitItem, uid, type Clip, type Project } from "./model";
import { isTrackLocked } from "./timelineOperations";

export type SceneFrame = { time: number; pixels: Uint8Array; histogram: Float32Array };
export type SceneCut = { time: number; strength: number; before?: string; after?: string };
export type SceneSettings = { sensitivity: number; minimum: number };
export const DEFAULT_SCENE_SETTINGS: SceneSettings = { sensitivity: 50, minimum: .5 };

/** Small spatial RGB grid plus normalized channel histograms. No model/download needed. */
export function sceneFingerprint(data: Uint8ClampedArray, width: number, height: number, time: number): SceneFrame {
  const pixels = new Uint8Array(32 * 18 * 3), histogram = new Float32Array(48);
  for (let y = 0; y < 18; y++) for (let x = 0; x < 32; x++) {
    const offset = (Math.min(height - 1, Math.floor((y + .5) * height / 18)) * width + Math.min(width - 1, Math.floor((x + .5) * width / 32))) * 4;
    for (let channel = 0; channel < 3; channel++) {
      const value = data[offset + channel];
      pixels[(y * 32 + x) * 3 + channel] = value;
      // Soft bins prevent a tiny brightness change across a bin edge looking like a cut.
      const bin = value / 17, lower = Math.floor(bin), blend = bin - lower, weight = 1 / (32 * 18 * 3);
      histogram[channel * 16 + lower] += (1 - blend) * weight;
      histogram[channel * 16 + Math.min(15, lower + 1)] += blend * weight;
    }
  }
  return { time, pixels, histogram };
}

export function sceneDifference(a: SceneFrame, b: SceneFrame): number {
  let spatial = 0, distribution = 0;
  for (let i = 0; i < a.pixels.length; i++) spatial += Math.abs(a.pixels[i] - b.pixels[i]);
  for (let i = 0; i < a.histogram.length; i++) distribution += Math.abs(a.histogram[i] - b.histogram[i]);
  return .7 * spatial / (a.pixels.length * 255) + .3 * distribution / 2;
}

/** Abrupt, persistent changes; one-sample flashes and gradual changes are rejected. */
export function findSceneCuts(frames: SceneFrame[], settings: SceneSettings): SceneCut[] {
  const threshold = .42 - Math.max(0, Math.min(100, settings.sensitivity)) * .0032;
  const scores = frames.map((frame, index) => index ? sceneDifference(frames[index - 1], frame) : 0);
  const candidates: SceneCut[] = [];
  for (let i = 1; i < frames.length - 1; i++) {
    const nearby = scores.slice(Math.max(1, i - 8), i).sort((a, b) => a - b);
    const baseline = nearby.length ? nearby[Math.floor(nearby.length / 2)] : 0;
    const strength = scores[i];
    if (strength < Math.max(threshold, baseline * 3 + .04) || strength < scores[i + 1]) continue;
    if (sceneDifference(frames[i - 1], frames[i + 1]) < threshold * .8) continue;
    if (i > 1 && scores[i - 1] >= threshold && sceneDifference(frames[i - 2], frames[i]) < threshold * .8) continue;
    const cut = { time: frames[i].time, strength };
    const previous = candidates.at(-1);
    if (previous && cut.time - previous.time < Math.max(.125, settings.minimum)) {
      if (cut.strength > previous.strength) candidates[candidates.length - 1] = cut;
    } else candidates.push(cut);
  }
  return candidates.filter(cut => cut.time - (frames[0]?.time ?? 0) >= settings.minimum && (frames.at(-1)?.time ?? 0) - cut.time >= settings.minimum);
}

export function sceneSourceKey(project: Project, clip: Clip): string {
  return JSON.stringify([project.id, project.fps, clip, project.assets.find(asset => asset.id === clip.assetId)?.url, isTrackLocked(project, clip.track)]);
}

/** One immutable edit/undo batch. Reuse the editor's audio/keyframe-safe split operation. */
export function applySceneCuts(project: Project, clipId: string, key: string, times: number[], mode: "split" | "markers" = "split"): Project {
  const clip = project.clips.find(item => item.id === clipId);
  if (!clip || clip.kind !== "video" || isTrackLocked(project, clip.track) || sceneSourceKey(project, clip) !== key || clip.frozenAt !== undefined || project.assets.find(asset => asset.id === clip.assetId)?.kind !== "video") return project;
  const duration = clipDuration(clip), frame = 1 / project.fps;
  const cuts = [...new Set(times.filter(Number.isFinite).map(time => roundFrame(time, project.fps)))].filter(time => time >= frame - 1e-8 && time <= duration - frame + 1e-8).sort((a, b) => a - b);
  if (!cuts.length || cuts.length > 300) return project;
  if (mode === "markers") {
    const markers = cuts.map(time => roundFrame(clip.start + time, project.fps)).filter(time => !project.markers.some(marker => marker.kind === "moment" && Math.abs(marker.time - time) < frame / 2));
    if (!markers.length) return project;
    return { ...project, markers: [...project.markers, ...markers.map(time => ({ id: uid("scene"), kind: "moment" as const, source: "scene" as const, time, sourceClipId: clip.id }))].sort((a, b) => a.time - b.time) };
  }
  return cuts.reverse().reduce((result, time) => splitItem(result, { kind: "clip", id: clipId }, clip.start + time).project, project);
}
