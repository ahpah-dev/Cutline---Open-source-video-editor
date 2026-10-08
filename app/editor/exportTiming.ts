import { animatedItem, clamp, endOf, trackKey, transitionWindow, type Clip, type Project } from "./model";

/** Wall-clock time must never decide which frame ends up in a saved edit. */
export function exportFrameCount(duration: number, fps: number) {
  return Math.max(1, Math.ceil(duration * fps - 1e-8));
}
export function exportFrameTime(index: number, fps: number) { return index / fps; }

export function clipExportRange(project: Project, clip: Clip) {
  const incoming = transitionWindow(project, clip);
  const outgoing = project.clips.map(other => transitionWindow(project, other)).find(window => window?.previous.id === clip.id);
  return { start: Math.max(0, incoming?.start ?? clip.start), end: outgoing?.end ?? endOf(clip), incoming, outgoing };
}

/** The same trim, fades, automation, layer visibility and two-sided joins as preview. */
export function exportAudioControl(project: Project, clip: Clip, time: number) {
  const range = clipExportRange(project, clip);
  const item = animatedItem(clip, time), pan = clamp(item.audioPan ?? 0,-1,1);
  if (time < range.start || time >= range.end || clip.frozenAt !== undefined ||
      project.mutedTracks.includes(trackKey(clip)) || project.hiddenTracks.includes(trackKey(clip))) return { gain: 0, pan };
  const incoming = range.incoming && time >= range.incoming.start && time < range.incoming.end;
  const outgoing = range.outgoing && time >= range.outgoing.start && time < range.outgoing.end;
  if (clip.kind === "video" && !incoming && !outgoing) {
    const active = project.clips.filter(other => other.kind === "video" && other.track === clip.track && time >= other.start && time < endOf(other))
      .sort((a,b) => a.start-b.start).at(-1);
    if (active?.id !== clip.id) return { gain: 0, pan };
  }
  const fade = Math.min(item.fadeIn > 0 ? clamp((time-range.start)/item.fadeIn,0,1) : 1,
    item.fadeOut > 0 ? clamp((range.end-time)/item.fadeOut,0,1) : 1);
  const join = incoming ? clamp((time-range.incoming!.start)/range.incoming!.duration,0,1)
    : outgoing ? 1-clamp((time-range.outgoing!.start)/range.outgoing!.duration,0,1) : 1;
  return { gain: clamp(item.volume,0,3)*fade*join, pan };
}

/** Web Audio's equal-power stereo panner; mono does not get doubled in the mix. */
export function panStereo(left: number, right: number, pan: number, mono: boolean): [number,number] {
  if (mono) { const angle = (pan+1)*Math.PI/4; return [left*Math.cos(angle),left*Math.sin(angle)]; }
  if (pan <= 0) { const angle = (pan+1)*Math.PI/2; return [left+right*Math.cos(angle),right*Math.sin(angle)]; }
  const angle = pan*Math.PI/2; return [left*Math.cos(angle),right+left*Math.sin(angle)];
}
