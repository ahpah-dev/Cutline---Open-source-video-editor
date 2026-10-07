import { clipDuration, endOf, layerCount, makeClip, roundFrame, type Clip, type Project, type Selection, type TextClip } from "./model";

type Item = Clip | TextClip;
type ItemSelection = NonNullable<Selection>;

export const isTrackLocked = (project: Project, track: number) =>
  (project.lockedTracks ?? []).includes(`layer:${track}`);

export function selectionItems(project: Project, selection: ItemSelection[]): Item[] {
  const ids = new Set(selection.map((item) => item.id));
  return [...project.clips, ...project.texts].filter((item) => ids.has(item.id));
}

/** Move a selection as a group, preserving its timing offsets and duration. */
export function alignSelectionToPlayhead(project: Project, selection: ItemSelection[], time: number, edge: "start" | "end"): Project {
  const items = selectionItems(project, selection);
  if (!items.length || items.some((item) => isTrackLocked(project, item.track))) return project;
  const earliest = Math.min(...items.map((item) => item.start));
  const anchor = edge === "start" ? earliest : Math.max(...items.map(endOf));
  const delta = Math.max(-earliest, roundFrame(time, project.fps) - anchor);
  if (delta === 0) return project;
  const ids = new Set(items.map((item) => item.id));
  const move = <T extends Item>(item: T): T => ids.has(item.id)
    ? { ...item, start: roundFrame(item.start + delta, project.fps) } : item;
  return { ...project, clips: project.clips.map(move), texts: project.texts.map(move) };
}

/** Locked layers survive deletion; ripple closes the union of removed gaps per layer. */
export function removeSelection(project: Project, selection: ItemSelection[], ripple: boolean): Project {
  const items = selectionItems(project, selection).filter((item) => !isTrackLocked(project, item.track));
  if (!items.length) return project;
  const ids = new Set(items.map((item) => item.id));
  const gaps = new Map<number, { start: number; end: number }[]>();
  if (ripple) {
    for (const item of items.toSorted((a, b) => a.start - b.start)) {
      const spans = gaps.get(item.track) ?? [];
      const previous = spans.at(-1);
      if (previous && item.start <= previous.end) previous.end = Math.max(previous.end, endOf(item));
      else spans.push({ start: item.start, end: endOf(item) });
      gaps.set(item.track, spans);
    }
  }
  const remaining = <T extends Item>(item: T): T => {
    const delta = (gaps.get(item.track) ?? []).reduce((total, gap) =>
      total + (item.start >= gap.end - 0.001 ? gap.end - gap.start : 0), 0);
    return delta ? { ...item, start: Math.max(0, roundFrame(item.start - delta, project.fps)) } : item;
  };
  return {
    ...project,
    clips: project.clips.filter((item) => !ids.has(item.id)).map(remaining),
    texts: project.texts.filter((item) => !ids.has(item.id)).map(remaining),
  };
}

/** Reuse the video source as audio; no rendering or conversion is required. */
export function detachClipAudio(project: Project, clipId: string): { project: Project; selection: Selection } {
  const clip = project.clips.find((item) => item.id === clipId);
  const asset = project.assets.find((item) => item.id === clip?.assetId);
  if (!clip || clip.kind !== "video" || asset?.kind !== "video" || clip.frozenAt !== undefined || isTrackLocked(project, clip.track))
    return { project, selection: null };
  const candidates = Array.from({ length: layerCount(project) }, (_, track) => track)
    .toSorted((a, b) => Math.abs(a - clip.track) - Math.abs(b - clip.track));
  const track = candidates.find((candidate) => candidate !== clip.track && !isTrackLocked(project, candidate)
    && ![...project.clips, ...project.texts].some((item) => item.track === candidate && item.start < endOf(clip) && endOf(item) > clip.start))
    ?? layerCount(project);
  const audio: Clip = {
    ...makeClip(asset, clip.start, track),
    label: `${clip.label} · Audio`,
    kind: "audio",
    sourceStart: clip.sourceStart,
    sourceEnd: clip.sourceEnd,
    speed: clip.speed,
    volume: clip.volume,
    audioPan: clip.audioPan ?? 0,
    fadeIn: Math.min(clipDuration(clip), clip.fadeIn),
    fadeOut: Math.min(clipDuration(clip), clip.fadeOut),
    propertyKeyframes: Object.fromEntries(Object.entries(clip.propertyKeyframes ?? {})
      .filter(([property]) => ["volume", "audioPan", "fadeIn", "fadeOut"].includes(property))
      .map(([property, keys]) => [property, structuredClone(keys)])),
  };
  const originalKeys = { ...clip.propertyKeyframes };
  delete originalKeys.volume;
  return {
    project: {
      ...project,
      layerCount: Math.max(layerCount(project), track + 1),
      clips: [...project.clips.map((item) => item.id === clip.id
        ? { ...item, volume: 0, propertyKeyframes: originalKeys } : item), audio],
    },
    selection: { kind: "clip", id: audio.id },
  };
}
