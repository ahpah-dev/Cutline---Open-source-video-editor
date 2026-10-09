import { normalizeBackgroundFill, type Project } from "./model";

/** Shared by the player, background swatch, AI previews and every export frame. */
export function drawProjectBackground(ctx: CanvasRenderingContext2D, project: Pick<Project, "background" | "backgroundFill">, width: number, height: number) {
  const fill = normalizeBackgroundFill(project.backgroundFill);
  let paint: string | CanvasGradient = project.background;
  if (fill.mode === "linear") {
    const angle = fill.angle * Math.PI / 180;
    const dx = Math.cos(angle), dy = Math.sin(angle);
    // Project all four corners onto the gradient direction, so the first and
    // last stops reach the edges at every angle and aspect ratio.
    const extent = (Math.abs(width * dx) + Math.abs(height * dy)) / 2;
    paint = ctx.createLinearGradient(width / 2 - dx * extent, height / 2 - dy * extent,
      width / 2 + dx * extent, height / 2 + dy * extent);
  } else if (fill.mode === "radial") {
    const x = width * fill.centerX, y = height * fill.centerY;
    paint = ctx.createRadialGradient(x, y, 0, x, y, Math.hypot(width, height) / 2 * fill.radius);
  }
  if (typeof paint !== "string") for (const stop of fill.stops) paint.addColorStop(stop.position, stop.color);
  ctx.fillStyle = paint;
  ctx.fillRect(0, 0, width, height);
}
