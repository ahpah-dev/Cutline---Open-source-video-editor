"use client";

import { useEffect, useRef, useState } from "react";
import { makeClip, newProject, type Asset, type EffectName, type Project, type TransitionName } from "./model";
import { Renderer, type MediaSources } from "./renderer";

// Catalogue-only artwork. These never enter the user's project or media library.
const SCENES = [
  `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><defs><linearGradient id="sky" x2="0" y2="1"><stop stop-color="#293d49"/><stop offset="1" stop-color="#8fbaa7"/></linearGradient><linearGradient id="hill" x2="0" y2="1"><stop stop-color="#4c8277"/><stop offset="1" stop-color="#163a3b"/></linearGradient><radialGradient id="sun"><stop stop-color="#ffdec0"/><stop offset="1" stop-color="#e8a981"/></radialGradient></defs><path fill="url(#sky)" d="M0 0h640v360H0z"/><circle cx="435" cy="115" r="57" fill="url(#sun)"/><path d="M0 228 130 143 270 248 395 190 640 267v93H0Z" fill="#a4c2aa"/><path d="M0 287 170 217 350 281 520 216 640 253v107H0Z" fill="url(#hill)"/><path d="M0 325q170-75 330-16t310-11v62H0Z" fill="#16353b"/><path d="M0 306q120-21 250 10t390-17M0 328q120-22 270 0t370-16M0 348q170-23 320-4t320-7" fill="none" stroke="#93c6b4" stroke-opacity=".38" stroke-width="2"/><path d="M75 90h135m-98 12h175m-30-24h132" stroke="#e5f2dc" stroke-opacity=".27" stroke-width="3"/></svg>`,
  `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><defs><linearGradient id="sky" x2="0" y2="1"><stop stop-color="#62494e"/><stop offset="1" stop-color="#f2b18b"/></linearGradient><linearGradient id="hill" x2="0" y2="1"><stop stop-color="#cf8d71"/><stop offset="1" stop-color="#744853"/></linearGradient></defs><path fill="url(#sky)" d="M0 0h640v360H0z"/><circle cx="180" cy="108" r="51" fill="#f7deae"/><path d="M0 270 165 158 330 245 476 138 640 227v133H0Z" fill="#d69b85"/><path d="M0 278q140-63 300 5t340-6v83H0Z" fill="url(#hill)"/><path d="M0 322q200-42 360-7t280-3v48H0Z" fill="#5d414e"/><path d="M0 295q155-37 302 2t338-10M0 318q170-31 338 1t302-14M0 343q170-27 345-3t295-6" fill="none" stroke="#e5b195" stroke-opacity=".42" stroke-width="2"/><path d="M330 83h155m-110 13h164m-38-24h78" stroke="#f6d4be" stroke-opacity=".3" stroke-width="3"/></svg>`,
] as const;

function loadScene(index: number) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Catalogue preview could not load."));
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(SCENES[index])}`;
  });
}

type Props = {
  kind: "effect"; name: EffectName; animate: boolean; amount: number;
} | {
  kind: "transition"; name: TransitionName; animate: boolean; amount?: never;
};
type Session = { renderer: Renderer; project: Project; sources: MediaSources };

/** Uses the real compositing engine; no CSS approximation of catalogue effects. */
export function LibraryPreview({ kind, name, animate, amount }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const host = useRef<HTMLSpanElement>(null);
  const session = useRef<Session | null>(null);
  const [visible, setVisible] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    if (!window.IntersectionObserver) { queueMicrotask(() => setVisible(true)); return; }
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { rootMargin: "24px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let renderer: Renderer | null = null;
    void Promise.all([loadScene(0), ...(kind === "transition" ? [loadScene(1)] : [])]).then((images) => {
      if (cancelled || !canvas.current) return;
      const asset: Asset = { id: "catalogue-a", name: "A", kind: "image", duration: 4, width: 640, height: 360, sizeLabel: "", theme: "" };
      const first = { ...makeClip(asset), id: "catalogue-clip-a", fit: "cover" as const };
      const project = { ...newProject(), id: "catalogue", assets: [asset], clips: [first] };
      const sources: MediaSources = new Map([[first.id, images[0]]]);
      if (kind === "effect") first.effects = [{ name, amount: amount ?? 50, ...(name === "Wavy" ? { waves: 4 } : {}) }];
      else {
        const nextAsset = { ...asset, id: "catalogue-b", name: "B" };
        const next = { ...makeClip(nextAsset, 4), id: "catalogue-clip-b", fit: "cover" as const, transition: name, transitionDuration: 2 };
        project.assets.push(nextAsset); project.clips.push(next);
        sources.set(next.id, images[1]);
      }
      renderer = new Renderer();
      session.current = { renderer, project, sources };
      renderer.draw(canvas.current, project, kind === "transition" ? 4 : 1.2, sources);
      setReady(true);
    }).catch(() => { /* The quiet SVG fallback remains visible if decoding is unavailable. */ });
    return () => {
      cancelled = true;
      session.current = null;
      renderer?.dispose();
      setReady(false);
    };
  }, [kind, name, amount, visible]);

  useEffect(() => {
    const target = canvas.current, current = session.current;
    if (!target || !current || !ready || !visible) return;
    if (!animate || name === "Strobe" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      current.renderer.draw(target, current.project, kind === "transition" ? 4 : 1.2, current.sources);
      return;
    }
    let frame = 0, last = 0;
    const started = performance.now();
    const tick = (stamp: number) => {
      if (stamp - last >= 1000 / 24) {
        const elapsed = (stamp - started) / 1000;
        const time = kind === "transition" ? 3 + Math.min(1, (elapsed % 2.5) / 2) * 2 : 1.2 + elapsed % 2.5;
        current.renderer.draw(target, current.project, time, current.sources);
        last = stamp;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [animate, ready, kind, name, visible]);

  return <span ref={host} className="preset-preview" data-preset-preview={name} data-preview-ready={ready} aria-hidden="true">
    <span className="preset-preview-fallback" style={{ backgroundImage: `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(SCENES[0])}")` }} />
    <canvas ref={canvas} width={192} height={108} style={{ opacity: ready ? 1 : 0 }} />
    {kind === "transition" ? <span className="preset-preview-label">A <span>→</span> B</span> : null}
    <span className="preset-preview-play">{name === "Strobe" ? "Static preview · flashing effect" : animate ? "Live preview" : "Hover to preview"}</span>
  </span>;
}
