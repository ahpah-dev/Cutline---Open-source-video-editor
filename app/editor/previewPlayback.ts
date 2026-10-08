import { animatedItem, clamp, endOf, trackKey, transitionWindow, type Clip, type Project } from './model';

/** The exact same active sources drive preview audio and its master clock. */
export function previewMediaStates(project: Project, time: number) {
  const joins = project.clips.flatMap(incoming => {
    if (incoming.kind !== 'video') return [];
    const window = transitionWindow(project, incoming);
    return window && time >= window.start && time < window.end ? [{ incoming, window }] : [];
  });
  return project.clips.flatMap(clip => {
    const visible = clip.kind === 'video' ? project.clips.filter(other => other.kind === 'video' && other.track === clip.track && time >= other.start && time < endOf(other)).sort((a,b) => a.start-b.start).at(-1) : null;
    const active = clip.kind === 'video' ? visible?.id === clip.id : time >= clip.start && time < endOf(clip);
    const incoming = joins.find(join => join.incoming.id === clip.id)?.window;
    const outgoing = joins.find(join => join.window.previous.id === clip.id)?.window;
    if (!active && !incoming && !outgoing) return [];
    const start = incoming?.start ?? clip.start, end = outgoing?.end ?? endOf(clip);
    const value = animatedItem(clip, time);
    const fade = Math.min(value.fadeIn > 0 ? clamp((time-start)/value.fadeIn,0,1) : 1, value.fadeOut > 0 ? clamp((end-time)/value.fadeOut,0,1) : 1);
    const mix = incoming ? clamp((time-incoming.start)/incoming.duration,0,1) : outgoing ? 1-clamp((time-outgoing.start)/outgoing.duration,0,1) : 1;
    const audible = clip.frozenAt === undefined && !project.mutedTracks.includes(trackKey(clip)) && !project.hiddenTracks.includes(trackKey(clip));
    const volume = audible ? value.volume*fade*mix : 0;
    return [{ clip, start, end, volume: Number.isFinite(volume) ? clamp(volume,0,3) : 0, pan: clamp(Number(value.audioPan)||0,-1,1) }];
  });
}

export function mediaToTimeline(clip: Clip, sourceTime: number) {
  return clip.start + (sourceTime-clip.sourceStart)/clip.speed;
}

/** Wall time is only a fallback for text, images and gaps; never chase audio. */
export class PreviewClock {
  constructor(public time: number, private at: number) {}
  sample(now: number, mediaTime?: number, blocked = false, fallbackLimit = Infinity) {
    const delta = Math.max(0,now-this.at);
    this.at = now;
    if (!blocked) this.time = Math.max(this.time, Number.isFinite(mediaTime) ? mediaTime! : Math.min(fallbackLimit,this.time+delta));
    return this.time;
  }
}
