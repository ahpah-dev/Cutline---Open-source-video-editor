import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type PointerEvent,
} from "react";
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  ChevronLeft,
  ChevronRight,
  Maximize2,
  Minimize2,
  Scan,
  Volume2,
  VolumeX,
  Shapes,
  LockKeyhole,
} from "lucide-react";
import {
  clamp,
  animatedItem,
  clock,
  dimensions,
  interpolatedTransform,
  projectDuration,
  trackKey,
  type Project,
  type Selection,
} from "./model";
import { Renderer, hitBounds, type Bounds } from "./renderer";
import { MediaPool } from "./media";
import { historyReducer } from "./useProject";
import { applyPreviewTransform, snapCanvasCenter } from "./previewAlignment";
import { maskGeometry, maskSvgPath, normalizeCompositing, type MaskFrame, type MaskGeometry } from "./visualCompositing";
import { applyMaskPatch, maskDragPatch } from "./maskEditing";
import { clipInActiveTransition } from "./transitionEditing";
type Props = {
  project: Project;
  selection: Selection;
  select: (s: Selection) => void;
  time: number;
  setTime: (t: number) => void;
  seek: (t: number) => void;
  playing: boolean;
  setPlaying: (v: boolean) => void;
  dispatch: Dispatch<Parameters<typeof historyReducer>[1]>;
  onError: (message: string) => void;
};
export function Preview({
  project,
  selection,
  select,
  time,
  setTime,
  seek,
  playing,
  setPlaying,
  dispatch,
  onError,
}: Props) {
  const canvas = useRef<HTMLCanvasElement>(null),
    stage = useRef<HTMLDivElement>(null),
    pool = useRef<MediaPool | null>(null),
    renderer = useRef<Renderer | null>(null);
  const [bound, setBound] = useState<Bounds | null>(null),
    [snapGuides, setSnapGuides] = useState({ x: false, y: false }),
    [loading, setLoading] = useState(false),
    [muted, setMuted] = useState(false),
    [guides, setGuides] = useState(false),
    [editingMask, setEditingMask] = useState<string | null>(null),
    [immersive, setImmersive] = useState(false);
  const ownsNativeFullscreen = useRef(false);
  const maskDrag = useRef<{
    id: string; kind: "clip" | "text"; mode: "move" | "size" | "rotate";
    x: number; y: number; time: number; project: Project;
    frame: MaskFrame; geometry: MaskGeometry; startAngle: number;
  } | null>(null);
  const exitPreviewFullscreen = useCallback(() => {
    if (document.fullscreenElement === stage.current) {
      void document.exitFullscreen();
      return;
    }
    setImmersive(false);
    if (ownsNativeFullscreen.current) {
      ownsNativeFullscreen.current = false;
      window.cutlineDesktop?.toggleFullscreen();
    }
  }, []);
  const togglePreviewFullscreen = useCallback(async () => {
    if (immersive || document.fullscreenElement === stage.current) {
      exitPreviewFullscreen();
      return;
    }
    const native = window.cutlineDesktop;
    if (native) {
      try {
        ownsNativeFullscreen.current = !(await native.isFullscreen());
        if (ownsNativeFullscreen.current) native.toggleFullscreen();
        setImmersive(true);
      } catch {
        onError("Could not open the full screen preview.");
      }
    } else {
      try {
        await stage.current?.requestFullscreen();
      } catch {
        setImmersive(true);
      }
    }
  }, [immersive, exitPreviewFullscreen, onError]);
  useEffect(() => {
    const changed = () => {
      if (document.fullscreenElement !== stage.current && !window.cutlineDesktop)
        setImmersive(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape" && immersive) {
        e.stopImmediatePropagation();
        exitPreviewFullscreen();
      }
    };
    const stopNative = window.cutlineDesktop?.onFullscreenChange((full) => {
      if (!full) {
        ownsNativeFullscreen.current = false;
        setImmersive(false);
      }
    });
    document.addEventListener("fullscreenchange", changed);
    window.addEventListener("keydown", escape, true);
    return () => {
      stopNative?.();
      document.removeEventListener("fullscreenchange", changed);
      window.removeEventListener("keydown", escape, true);
    };
  }, [immersive, exitPreviewFullscreen]);
  const latest = useRef({ project, selection, time, playing, muted });
  const start = useRef({ at: 0, time: 0 }),
    drag = useRef<{
      id: string;
      kind: "clip" | "text";
      mode: "move" | "scale";
      x: number;
      y: number;
      project: Project;
      bound: Bounds;
    } | null>(null);
  useEffect(() => {
    latest.current = { project, selection, time, playing, muted };
  }, [project, selection, time, playing, muted]);
  useEffect(() => {
    const media = new MediaPool();
    pool.current = media;
    renderer.current = new Renderer();
    return () => {
      media.dispose();
      renderer.current?.dispose();
      pool.current = null;
      renderer.current = null;
    };
  }, []);
  useEffect(() => {
    let active = true;
    const media = pool.current;
    if (!media) return;
    const timer = setTimeout(() => {
      if (active) setLoading(true);
    }, 300);
    void media
      .ensure(project)
      .then(async () => {
        if (active && !latest.current.playing)
          await media.sync(project, latest.current.time, false);
      })
      .catch((error) => {
        if (active) onError(error.message);
      })
      .finally(() => {
        clearTimeout(timer);
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [project, onError]);
  useEffect(() => {
    if (playing) {
      start.current = { at: performance.now(), time: latest.current.time };
      void pool.current?.enableAudio().catch((error) => onError(error.message));
    } else pool.current?.pause();
  }, [playing, onError]);
  useEffect(() => {
    let frame = 0,
      lastUi = 0,
      lastBounds = "",
      failed = false;
    let renderedProject: Project | null = null,
      renderedTime = -1,
      revision = -1,
      drawnAt = 0;
    const tick = (now: number) => {
      const p = latest.current,
        media = pool.current,
        draw = renderer.current,
        target = canvas.current;
      if (media && draw && target) {
        const duration = projectDuration(p.project);
        const t = p.playing
          ? Math.min(
              duration,
              start.current.time + (now - start.current.at) / 1000,
            )
          : p.time;
        if (p.playing && t >= duration) {
          setPlaying(false);
          setTime(duration);
        } else if (p.playing && now - lastUi > 32) {
          setTime(t);
          lastUi = now;
        }
        const renderProject = p.muted
          ? {
              ...p.project,
              mutedTracks: p.project.clips.map(trackKey),
            }
          : p.project;
        void media
          .sync(
            renderProject,
            t,
            p.playing && t < duration,
          )
          .catch((error) => {
            if (!failed) {
              failed = true;
              onError(error.message);
            }
          });
        const size = dimensions(p.project.ratio, 540);
        if (target.width !== size.width || target.height !== size.height)
          Object.assign(target, size);
        const shouldDraw =
          renderedProject !== p.project ||
          revision !== media.revision ||
          (p.playing
            ? now - drawnAt >= 1000 / p.project.fps
            : renderedTime !== t);
        if (shouldDraw) {
          draw.draw(
            target,
            p.project,
            t,
            media.sources,
          );
          renderedProject = p.project;
          renderedTime = t;
          revision = media.revision;
          drawnAt = now;
        }
        const bounds = draw.bounds;
        const selected = bounds.find((b) => b.id === p.selection?.id) ?? null;
        const serialized = JSON.stringify(selected);
        if (serialized !== lastBounds) {
          setBound(selected);
          lastBounds = serialized;
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [setPlaying, setTime, onError]);
  function begin(e: PointerEvent<HTMLElement>, mode: "move" | "scale") {
    if (e.button !== 0 || !canvas.current || !renderer.current) return;
    const rect = canvas.current.getBoundingClientRect();
    const hit =
      mode === "scale"
        ? bound
        : hitBounds(
            renderer.current.bounds,
            ((e.clientX - rect.left) / rect.width) * canvas.current.width,
            ((e.clientY - rect.top) / rect.height) * canvas.current.height,
          );
    if (!hit) {
      select(null);
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    setPlaying(false);
    select({ kind: hit.kind, id: hit.id });
    const item = hit.kind === "text" ? project.texts.find((t) => t.id === hit.id) : project.clips.find((c) => c.id === hit.id);
    if (!item || project.lockedTracks.includes(trackKey(item))) return;
    if (hit.kind === "clip" && clipInActiveTransition(project, hit.id, time)) {
      onError("Move the playhead outside the transition to edit the clip's position or mask on canvas.");
      return;
    }
    dispatch({ type: "begin" });
    e.currentTarget.setPointerCapture(e.pointerId);
    setSnapGuides({ x: false, y: false });
    drag.current = {
      id: hit.id,
      kind: hit.kind,
      mode,
      x: e.clientX,
      y: e.clientY,
      project,
      bound: hit,
    };
  }
  function move(e: PointerEvent<HTMLElement>) {
    if (maskDrag.current && canvas.current) {
      const d = maskDrag.current, rect = canvas.current.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const x = (e.clientX - rect.left) / rect.width * canvas.current.width;
      const y = (e.clientY - rect.top) / rect.height * canvas.current.height;
      const original = d.kind === "text" ? d.project.texts.find((t) => t.id === d.id)! : d.project.clips.find((c) => c.id === d.id)!;
      const angle = Math.atan2(y - d.geometry.y, x - d.geometry.x);
      const delta = Math.atan2(Math.sin(angle - d.startAngle), Math.cos(angle - d.startAngle)) * 180 / Math.PI;
      const patch = maskDragPatch(animatedItem(original, d.time), d.frame, d.geometry, d.mode, x - d.x, y - d.y, delta);
      if (e.shiftKey && typeof patch.maskRotation === "number") patch.maskRotation = Math.round(patch.maskRotation / 15) * 15;
      dispatch({ type: "preview", fn: (p) => {
        const current = d.kind === "text" ? p.texts.find((t) => t.id === d.id) : p.clips.find((c) => c.id === d.id);
        if (!current || p.lockedTracks.includes(trackKey(current))) return p;
        return d.kind === "text" ? { ...p, texts: p.texts.map((t) => t.id === d.id ? applyMaskPatch(original as typeof t, patch, d.time, p.fps) : t) }
          : { ...p, clips: p.clips.map((c) => c.id === d.id ? applyMaskPatch(original as typeof c, patch, d.time, p.fps) : c) };
      } });
      return;
    }
    const d = drag.current;
    if (!d || !canvas.current) return;
    const rect = canvas.current.getBoundingClientRect(),
      dx = (e.clientX - d.x) / rect.width,
      dy = (e.clientY - d.y) / rect.height;
    const item = d.kind === "text" ? d.project.texts.find((t) => t.id === d.id) : d.project.clips.find((c) => c.id === d.id);
    if (!item || !rect.width || !rect.height) return;
    const transform = "keyframes" in item ? interpolatedTransform(item, time - item.start) : animatedItem(item, time);
    const isText = d.kind === "text", target = isText ? 0.5 : 0;
    const position = snapCanvasCenter(
      clamp(transform.x + dx, isText ? -0.5 : -2, isText ? 1.5 : 2),
      clamp(transform.y + dy, isText ? -0.5 : -2, isText ? 1.5 : 2),
      d.bound.x / canvas.current.width - (isText ? 0 : 0.5) - transform.x,
      d.bound.y / canvas.current.height - (isText ? 0 : 0.5) - transform.y,
      target, rect.width, rect.height, d.mode === "move" && item.snapToGuides !== false && !e.altKey,
    );
    setSnapGuides({ x: position.snapX, y: position.snapY });
    dispatch({
      type: "preview",
      fn: (p) => {
        const current = d.kind === "text" ? p.texts.find((t) => t.id === d.id) : p.clips.find((c) => c.id === d.id);
        if (!current || p.lockedTracks.includes(trackKey(current))) return p;
        if (d.kind === "text") {
          const original = d.project.texts.find((t) => t.id === d.id)!;
          return {
            ...p,
            texts: p.texts.map((t) =>
              t.id !== d.id
                ? t
                : applyPreviewTransform(original, d.mode === "move"
                      ? {
                          x: position.x,
                          y: position.y,
                        }
                      : {
                          fontSize: clamp(
                            animatedItem(original, time).fontSize * (1 + dx * 3 + dy * 2),
                            12,
                            400,
                          ),
                        }, time, p.fps),
            ),
          };
        }
        const original = d.project.clips.find((c) => c.id === d.id)!;
        const transform = interpolatedTransform(
          original,
          time - original.start,
        );
        const patch =
          d.mode === "move"
            ? {
                x: position.x,
                y: position.y,
              }
            : {
                scale: clamp(transform.scale * (1 + dx * 2 + dy * 2), 0.05, 5),
              };
        return {
          ...p,
          clips: p.clips.map((c) =>
            c.id !== d.id
              ? c
              : applyPreviewTransform(original, patch, time, p.fps),
          ),
        };
      },
    });
  }
  const finish = () => {
    if (drag.current || maskDrag.current) {
      drag.current = null;
      maskDrag.current = null;
      setSnapGuides({ x: false, y: false });
      dispatch({ type: "commit" });
    }
  };
  useEffect(() => {
    const cancel = (e: KeyboardEvent) => {
      if (e.key === "Escape" && (drag.current || maskDrag.current)) {
        drag.current = null;
        maskDrag.current = null;
        setSnapGuides({ x: false, y: false });
        dispatch({ type: "cancel" });
      }
    };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, [dispatch]);
  const size = dimensions(project.ratio, 540),
    duration = projectDuration(project);
  const sourceItem = selection?.kind === "text" ? project.texts.find((t) => t.id === selection.id)
    : project.clips.find((c) => c.id === selection?.id);
  const selectedItem = sourceItem ? animatedItem(sourceItem, time) : undefined;
  const locked = Boolean(selectedItem && project.lockedTracks.includes(trackKey(selectedItem)));
  const transitionActive = Boolean(selection?.kind === "clip" && clipInActiveTransition(project, selection.id, time));
  const mask = selectedItem ? normalizeCompositing(selectedItem) : null;
  const maskActive = Boolean(bound && selectedItem && mask?.maskShape !== "None" && editingMask === selectedItem.id && !playing && !transitionActive);
  const contentFrame: MaskFrame | null = bound;
  const geometry = selectedItem && contentFrame ? maskGeometry(selectedItem, contentFrame, size.width, size.height) : null;
  function beginMask(e: PointerEvent<HTMLElement>, mode: "move" | "size" | "rotate") {
    if (e.button !== 0 || !canvas.current || !geometry || !contentFrame || !selectedItem || locked || transitionActive) return;
    e.preventDefault(); e.stopPropagation();
    setPlaying(false);
    const rect = canvas.current.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width * size.width, y = (e.clientY - rect.top) / rect.height * size.height;
    maskDrag.current = { id: selectedItem.id, kind: selection!.kind, mode, x, y, time, project, geometry,
      frame: mask?.maskSpace === "canvas" ? { x: size.width / 2, y: size.height / 2, width: size.width, height: size.height, rotation: 0 } : contentFrame,
      startAngle: Math.atan2(y - geometry.y, x - geometry.x) };
    dispatch({ type: "begin" });
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  return (
    <section className="preview-panel">
      <div className="panel-heading">
        <span>
          Preview <span className="subtle-badge">{project.ratio}</span><span className="preview-fps">{project.fps} fps</span>
        </span>
        <div className="tool-group">
          {transitionActive && <span className="subtle-badge" title="Move the playhead outside the transition to edit position or mask handles." role="status">Transition preview</span>}
          {selectedItem && mask?.maskShape !== "None" && <button type="button"
            title={transitionActive ? "Move the playhead outside the transition to edit the mask" : "Edit mask on canvas"} aria-label="Edit mask" aria-pressed={maskActive} disabled={locked || transitionActive}
            className={maskActive ? "active mask-edit-button" : "mask-edit-button"}
            onClick={() => { setPlaying(false); setEditingMask(editingMask === selectedItem.id ? null : selectedItem.id); }}>
            <Shapes size={15} /><span>Edit mask</span>
          </button>}
          <button
            title="Composition guides"
            aria-label="Toggle composition guides"
            className={guides ? "active" : ""}
            onClick={() => setGuides(!guides)}
          >
            <Scan size={16} />
          </button>
          <button
            title="Fullscreen preview"
            aria-label="Fullscreen preview"
            onClick={() => void togglePreviewFullscreen()}
          >
            <Maximize2 size={16} />
          </button>
        </div>
      </div>
      <div className={"preview-stage" + (immersive ? " preview-immersive" : "")} ref={stage}>
        <button
          className="preview-fullscreen-exit"
          type="button"
          aria-label="Exit fullscreen preview"
          onClick={exitPreviewFullscreen}
        >
          <Minimize2 size={18} /> Exit preview
        </button>
        <div
          className={"canvas-wrap ratio-" + project.ratio.replace(":", "-")}
          style={{ aspectRatio: project.ratio.replace(":", "/") }}
          onPointerMove={move}
          onPointerUp={finish}
          onPointerCancel={() => {
            drag.current = null;
            maskDrag.current = null;
            setSnapGuides({ x: false, y: false });
            dispatch({ type: "cancel" });
          }}
        >
          <canvas
            ref={canvas}
            width={size.width}
            height={size.height}
            aria-label="Video preview. Drag selected video or text to reposition it."
            onPointerDown={(e) => maskActive ? beginMask(e, "move") : begin(e, "move")}
          />
          {guides && (
            <div className="composition-guides">
              <i />
              <i />
              <b />
              <b />
            </div>
          )}
          {(snapGuides.x || snapGuides.y) && (
            <div className="alignment-snap-guides" aria-hidden="true">
              {snapGuides.x && <i />}
              {snapGuides.y && <b />}
            </div>
          )}
          {maskActive && geometry && <MaskOverlay geometry={geometry} size={size} locked={locked} begin={beginMask} />}
          {bound && !playing && !maskActive && !transitionActive && (
            <div
              className={"selection-box" + (locked ? " selection-locked" : "")}
              style={{
                left: (bound.x / size.width) * 100 + "%",
                top: (bound.y / size.height) * 100 + "%",
                width: (bound.width / size.width) * 100 + "%",
                height: (bound.height / size.height) * 100 + "%",
                transform:
                  "translate(-50%, -50%) rotate(" + bound.rotation + "deg)",
              }}
            >
              <span className="corner top-left" />
              <span className="corner top-right" />
              <span className="corner bottom-left" />
              <button
                className="corner bottom-right"
                title="Drag to resize"
                aria-label="Resize selected layer"
                disabled={locked}
                onPointerDown={(e) => begin(e, "scale")}
              />
              <div className="selection-label">
                {locked ? <><LockKeyhole size={11} /> Locked layer</> : <>{bound.kind === "text" ? "Text" : "Video"} · drag to move</>}
              </div>
            </div>
          )}
          {loading && (
            <div className="preview-loading">
              <span className="spinner" />
              Loading media
            </div>
          )}
          {duration === 0 && (
            <div className="preview-empty">
              <span>Your next great edit</span>
              <small>Import media or add a text layer to begin.</small>
            </div>
          )}
        </div>
      </div>
      <div className="player-controls">
        <span className="timecode">
          <strong>{clock(time, true, project.fps)}</strong>
          <span> / {clock(duration, true, project.fps)}</span>
        </span>
        <div className="transport">
          <button
            title="Go to start"
            aria-label="Go to start"
            onClick={() => seek(0)}
          >
            <SkipBack size={15} />
          </button>
          <button
            title="Previous frame"
            aria-label="Previous frame"
            onClick={() => seek(Math.max(0, time - 1 / project.fps))}
          >
            <ChevronLeft size={17} />
          </button>
          <button
            className="play-button"
            title="Play / pause · Space"
            aria-label={playing ? "Pause" : "Play"}
            disabled={!duration}
            onClick={() => {
              if (time >= duration) seek(0);
              setPlaying(!playing);
            }}
          >
            {playing ? (
              <Pause size={20} fill="currentColor" />
            ) : (
              <Play size={20} fill="currentColor" />
            )}
          </button>
          <button
            title="Next frame"
            aria-label="Next frame"
            onClick={() => seek(time + 1 / project.fps)}
          >
            <ChevronRight size={17} />
          </button>
          <button
            title="Go to end"
            aria-label="Go to end"
            onClick={() => seek(duration)}
          >
            <SkipForward size={15} />
          </button>
        </div>
        <button
          className="preview-volume"
          title="Mute preview only"
          aria-label={muted ? "Unmute preview" : "Mute preview"}
          onClick={() => setMuted(!muted)}
        >
          {muted ? <VolumeX size={17} /> : <Volume2 size={17} />}
        </button>
      </div>
    </section>
  );
}
function MaskOverlay({ geometry: g, size, locked, begin }: {
  geometry: MaskGeometry; size: { width: number; height: number }; locked: boolean;
  begin: (e: PointerEvent<HTMLElement>, mode: "move" | "size" | "rotate") => void;
}) {
  const angle = g.rotation * Math.PI / 180;
  const point = (x: number, y: number) => ({ x: g.x + Math.cos(angle) * x - Math.sin(angle) * y, y: g.y + Math.sin(angle) * x + Math.cos(angle) * y });
  const halfWidth = g.shape === "Linear" || g.shape === "Mirror" ? size.width / 2 : g.width / 2;
  const height = g.shape === "Linear" ? 0 : g.height / 2;
  const rotation = point(0, -height - 32), corner = point(halfWidth, height);
  const position = (p: { x: number; y: number }) => ({ left: p.x / size.width * 100 + "%", top: p.y / size.height * 100 + "%" });
  return <div className="mask-overlay" aria-label="Mask editing controls">
    <svg viewBox={`0 0 ${size.width} ${size.height}`} preserveAspectRatio="none" aria-hidden="true">
      <g transform={`translate(${g.x} ${g.y}) rotate(${g.rotation})`}>
        {g.shape === "Linear" ? <path className="mask-outline" d={`M ${-size.width * 2} 0 H ${size.width * 2}`} />
          : g.shape === "Mirror" ? <path className="mask-outline" d={`M ${-size.width * 2} ${-height} H ${size.width * 2} M ${-size.width * 2} ${height} H ${size.width * 2}`} />
            : <path className="mask-outline" vectorEffect="non-scaling-stroke" d={maskSvgPath(g.shape)} transform={`scale(${g.flipX ? -g.width : g.width} ${g.flipY ? -g.height : g.height}) translate(-.5 -.5)`} />}
        <path className="mask-handle-line" d={`M 0 ${-height} V ${-height - 32}`} />
      </g>
    </svg>
    <button type="button" className="mask-move-handle" aria-label="Move mask" title="Drag mask position" disabled={locked} style={position(g)} onPointerDown={(e) => begin(e, "move")}><Shapes size={13} /></button>
    {g.shape !== "Linear" && <button type="button" className="mask-size-handle" aria-label="Resize mask" title="Drag mask size" disabled={locked} style={position(corner)} onPointerDown={(e) => begin(e, "size")} />}
    <button type="button" className="mask-rotate-handle" aria-label="Rotate mask" title="Drag to rotate · Shift snaps 15°" disabled={locked} style={position(rotation)} onPointerDown={(e) => begin(e, "rotate")} />
    <span className="mask-overlay-label">{g.shape} mask{g.invert ? " · inverted" : ""}</span>
  </div>;
}
