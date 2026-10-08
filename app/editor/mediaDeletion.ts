import type { Project } from "./model";
import { isTrackLocked } from "./timelineOperations";

export function mediaDeletionInfo(project: Project, assetId: string) {
  const clips = project.clips.filter(clip => clip.assetId === assetId);
  return { clipCount: clips.length, locked: clips.some(clip => isTrackLocked(project, clip.track)) };
}

export function removeProjectMedia(project: Project, assetId: string): Project {
  if (!project.assets.some(asset => asset.id === assetId)) return project;
  if (mediaDeletionInfo(project, assetId).locked) throw new Error("Unlock the layers using this media before deleting it.");
  const removed = new Set(project.clips.filter(clip => clip.assetId === assetId).map(clip => clip.id));
  return {
    ...project,
    assets: project.assets.filter(asset => asset.id !== assetId),
    clips: project.clips.filter(clip => !removed.has(clip.id)),
    markers: project.markers?.filter(marker => !marker.sourceClipId || !removed.has(marker.sourceClipId)),
  };
}
