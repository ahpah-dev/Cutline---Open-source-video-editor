/* Local blob/file sources must remain native media elements for offline desktop use. */
/* eslint-disable @next/next/no-img-element */
import { useEffect, useRef, useState, type PointerEvent } from "react";
import { RotateCcw, X } from "lucide-react";
import { clipDuration, clamp, type Asset, type Clip } from "./model";
import { cropToAspect, dragCrop, FULL_CROP, normalizeCrop, type SourceCrop } from "./crop";

type Props = { clip: Clip; asset: Asset; time: number; apply: (crop: SourceCrop) => void; cancel: () => void };
const RATIOS = ["Free", "Original", "16:9", "9:16", "1:1", "4:5", "4:3"];
export function CropDialog({ clip, asset, time, apply, cancel }: Props) {
  const dialog = useRef<HTMLDialogElement>(null), stage = useRef<HTMLDivElement>(null);
  const [crop, setCrop] = useState(() => normalizeCrop(clip.crop));
  const [ratio, setRatio] = useState("Free"), [ready, setReady] = useState(false), [error, setError] = useState(asset.url ? "" : "Source unavailable. Relink or re-import this media, then retry.");
  const [size, setSize] = useState({ width: asset.width || 1920, height: asset.height || 1080 });
  const drag = useRef<{ crop: SourceCrop; mode: Parameters<typeof dragCrop>[1]; x: number; y: number; width: number; height: number; ratio?: number } | null>(null);
  const sourceRatio = size.width / size.height;
  const chosenRatio = ratio === "Free" ? undefined : ratio === "Original" ? sourceRatio : Number(ratio.split(":")[0]) / Number(ratio.split(":")[1]);
  useEffect(() => { const element = dialog.current!; element.showModal(); return () => { element.close(); }; }, []);
  const begin = (event: PointerEvent, mode: Parameters<typeof dragCrop>[1]) => {
    if (event.button !== 0 || !ready || !stage.current) return;
    event.preventDefault(); event.stopPropagation();
    const rect = stage.current.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    stage.current.setPointerCapture(event.pointerId);
    drag.current = { crop, mode, x: event.clientX, y: event.clientY, width: rect.width, height: rect.height, ratio: chosenRatio && chosenRatio / sourceRatio };
  };
  const move = (event: PointerEvent) => {
    const value = drag.current;
    if (value) setCrop(dragCrop(value.crop, value.mode, (event.clientX - value.x) / value.width, (event.clientY - value.y) / value.height, value.ratio));
  };
  const changeRatio = (name: string) => {
    setRatio(name);
    if (name !== "Free") {
      const selected = name === "Original" ? sourceRatio : Number(name.split(":")[0]) / Number(name.split(":")[1]);
      setCrop(cropToAspect(FULL_CROP, selected, sourceRatio));
    }
  };
  return <dialog ref={dialog} className="crop-dialog" aria-labelledby="crop-title" onCancel={(event) => { event.preventDefault(); cancel(); }} onKeyDown={(event) => event.stopPropagation()}>
    <form onSubmit={(event) => { event.preventDefault(); if (ready && !error) apply(normalizeCrop(crop)); }}>
      <header><div><h2 id="crop-title">Crop media</h2><p>Drag the box to reposition. Drag a corner to resize.</p></div><button type="button" className="icon-button" aria-label="Cancel crop" onClick={cancel}><X size={18} /></button></header>
      <div className="crop-ratios" aria-label="Crop aspect ratios">{RATIOS.map((name) => <button type="button" key={name} aria-pressed={ratio === name} className={ratio === name ? "active" : ""} disabled={!ready} onClick={() => changeRatio(name)}>{name}</button>)}</div>
      <div className="crop-source-stage" ref={stage} style={{ aspectRatio: sourceRatio, width: `min(700px, calc((100dvh - 310px) * ${sourceRatio}))` }} onPointerMove={move} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { if (drag.current) setCrop(drag.current.crop); drag.current = null; }}>
        {asset.kind === "image" ? <img src={asset.url} alt="Full source for cropping" draggable={false} onLoad={(event) => { setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight }); setReady(true); }} onError={() => setError("The image could not load. Relink or re-import it, then retry.")} /> : <video src={asset.url} muted playsInline preload="auto" onLoadedMetadata={(event) => {
          const video = event.currentTarget; setSize({ width: video.videoWidth, height: video.videoHeight });
          video.currentTime = clamp(clip.frozenAt ?? clip.sourceStart + clamp(time - clip.start, 0, clipDuration(clip)) * clip.speed, 0, Math.max(0, video.duration - 0.001));
        }} onLoadedData={(event) => { if (!event.currentTarget.seeking) setReady(true); }} onSeeked={() => setReady(true)} onError={() => setError("The video could not load. Relink or re-import it, then retry.")} />}
        {ready && !error && <div className="source-crop-box" aria-label="Crop selection" style={{ left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.width * 100}%`, height: `${crop.height * 100}%` }} onPointerDown={(event) => begin(event, "move")}>
          <span className="crop-thirds" aria-hidden="true" />
          {(["nw", "ne", "sw", "se"] as const).map((corner) => <button type="button" key={corner} className={`crop-handle ${corner}`} aria-label={`Resize crop ${corner}`} onPointerDown={(event) => begin(event, corner)} />)}
        </div>}
        {!ready && !error && <span className="crop-loading" role="status">Loading source…</span>}
      </div>
      {error && <p role="alert" className="crop-load-error">{error}</p>}
      <div className="crop-numbers">{(["x", "y", "width", "height"] as const).map((key) => <label key={key}>{({ x: "Left", y: "Top", width: "Width", height: "Height" })[key]} (%)<input type="number" aria-label={`Crop ${key} (%)`} value={Number((crop[key] * 100).toFixed(2))} min={key === "x" || key === "y" ? 0 : 1} max={100} step={0.1} disabled={!ready} onChange={(event) => { setRatio("Free"); setCrop(normalizeCrop({ ...crop, [key]: Number(event.target.value) / 100 })); }} /></label>)}</div>
      <footer><button type="button" className="button" onClick={() => { setRatio("Free"); setCrop({ ...FULL_CROP }); }}><RotateCcw size={14} /> Reset</button><small>Original file stays untouched. The crop fits inside the canvas.</small><button type="button" className="button" onClick={cancel}>Cancel</button><button type="submit" className="button primary" disabled={!ready || Boolean(error)}>Apply crop</button></footer>
    </form>
  </dialog>;
}
