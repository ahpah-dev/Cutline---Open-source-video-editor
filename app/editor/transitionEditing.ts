import { transitionWindow, type Project } from "./model";

/** Canvas handles edit a clip's base transform, not the extra transition transform. */
export function clipInActiveTransition(project: Project, id: string, time: number): boolean {
  const clip = project.clips.find((item) => item.id === id);
  if (!clip || clip.kind !== "video") return false;
  // Cheap candidate rejection avoids resolving every timeline join at playback FPS.
  return project.clips.some((incoming) => {
    if (incoming.kind !== "video" || incoming.track !== clip.track || incoming.transition === "None"
      || time < incoming.start - incoming.transitionDuration / 2 || time >= incoming.start + incoming.transitionDuration / 2) return false;
    const window = transitionWindow(project, incoming);
    return Boolean(window && time >= window.start && time < window.end && (incoming.id === id || window.previous.id === id));
  });
}
