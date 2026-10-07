import {
  useCallback,
  useEffect,
  memo,
  useRef,
  useState,
  type Dispatch,
  type PointerEvent as ReactPointerEvent,
  type MouseEvent as ReactMouseEvent,
  type DragEvent as ReactDragEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  Eye,
  EyeOff,
  Volume2,
  VolumeX,
  Magnet,
  Minus,
  Plus,
  Scissors,
  Copy,
  Trash2,
  Undo2,
  Redo2,
  Film,
  Music2,
  Type,
  ChevronDown,
  Layers,
  ArrowUp,
  ArrowDown,
  Snowflake,
  ClipboardPaste,
  Flag,
  Bookmark,
  AudioLines,
  LockKeyhole,
  LockKeyholeOpen,
  AlignStartHorizontal,
  AlignEndHorizontal,
} from "lucide-react";
import {
  clamp,
  clipDuration,
  clock,
  endOf,
  makeClip,
  layerCount,
  insertLayer,
  moveToLayer,
  projectDuration,
  roundFrame,
  snapPosition,
  trimItem,
  transitionSource,
  transitionWindow,
  toggleTimelineMarker,
  type Clip,
  type Project,
  type Selection,
  type TextClip,
  type TransitionName,
  type TimelineMarker,
} from "./model";
import { TRANSITIONS } from "./presets";
import { historyReducer } from "./useProject";
import { waveformColumns } from "./waveform";
import { alignSelectionToPlayhead, isTrackLocked, selectionItems } from "./timelineOperations";
type Action = Parameters<typeof historyReducer>[1];
type MenuAction = "copy" | "paste" | "split" | "freeze" | "duplicate" | "delete" | "detach-audio";
type Props = {
  project: Project;
  selection: Selection;
  select: (s: Selection) => void;
  selected: NonNullable<Selection>[];
  selectMany: (s: NonNullable<Selection>[]) => void;
  time: number;
  seek: (t: number) => void;
  edit: (fn: (p: Project) => Project, group?: string) => void;
  dispatch: Dispatch<Action>;
  canUndo: boolean;
  canRedo: boolean;
  split: () => void;
  duplicate: () => void;
  remove: () => void;
  hasClipboard: boolean;
  onClipMenuAction: (action: MenuAction, item: Clip | TextClip) => void;
  draggingTransition: TransitionName | null;
  onApplyTransition: (incomingId: string | null, name: TransitionName) => void;
  onOpenTransitions: (incomingId: string) => void;
  ripple: boolean;
  setRipple: (v: boolean) => void;
  onDetectBeats?:()=>void;
};
type Drag = {
  item: Clip | TextClip;
  group: (Clip | TextClip)[];
  type: "move" | "left" | "right";
  kind: "clip" | "text";
  x: number;
  y: number;
  currentX: number;
  currentY: number;
  scroll: number;
  alt: boolean;
  element: HTMLElement;
  pointerId: number;
  last: string;
  moved: boolean;
};
export function Timeline({
  project,
  selection,
  select,
  selected,
  selectMany,
  time,
  seek,
  edit,
  dispatch,
  canUndo,
  canRedo,
  split,
  duplicate,
  remove,
  hasClipboard,
  onClipMenuAction,
  draggingTransition,
  onApplyTransition,
  onOpenTransitions,
  ripple,
  setRipple,
  onDetectBeats,
}: Props) {
  const [pps, setPps] = useState(64),
    [snapping, setSnapping] = useState(true),
    [guide, setGuide] = useState<number | null>(null),
    [viewport, setViewport] = useState({ left: 0, width: 1000 }),
    [workspaceEnd, setWorkspaceEnd] = useState(60);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [hoverJoinId, setHoverJoinId] = useState<string | null>(null);
  const [marquee, setMarquee] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const scroll = useRef<HTMLDivElement>(null),
    headers = useRef<HTMLDivElement>(null),
    content = useRef<HTMLDivElement>(null),
    dragging = useRef<Drag | null>(null),
    marqueeDrag = useRef<{ x: number; y: number; currentX: number; currentY: number; pointerId: number; element: HTMLElement } | null>(null),
    scrubbing = useRef<{
      x: number;
      currentX: number;
      element: HTMLElement;
      pointerId: number;
    } | null>(null),
    updateDrag = useRef<() => void>(() => {});
  const duration = projectDuration(project);
  const playheadFrame = roundFrame(time, project.fps);
  const hasBeatMarker = project.markers.some((marker) => marker.kind === "beat" && marker.time === playheadFrame);
  const hasMomentMarker = project.markers.some((marker) => marker.kind === "moment" && marker.time === playheadFrame);
  // Editing space is independent of media/export duration. Keep a screenful
  // ahead of navigation, and never collapse it when clips are trimmed/deleted.
  const padding = Math.max(30, viewport.width / pps);
  const timelineEnd = Math.max(workspaceEnd, Math.ceil(Math.max(
    60, duration + padding, time + padding,
    ...project.markers.map((marker) => marker.time + padding),
    (viewport.left + viewport.width * 2) / pps,
  ) / 30) * 30);
  const width = timelineEnd * pps;
  const syncViewport = useCallback(() => {
    const el = scroll.current;
    if (!el) return;
    const next = { left: el.scrollLeft, width: el.clientWidth || 1000 };
    setViewport((old) => old.left === next.left && old.width === next.width ? old : next);
  }, []);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setWorkspaceEnd((end) => Math.max(end, timelineEnd)));
    return () => cancelAnimationFrame(frame);
  }, [timelineEnd]);
  useEffect(() => {
    syncViewport();
    const observer = typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(syncViewport) : null;
    if (scroll.current) observer?.observe(scroll.current);
    window.addEventListener("resize", syncViewport);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", syncViewport);
    };
  }, [syncViewport]);
  useEffect(() => {
    const el = scroll.current;
    if (!el || dragging.current || scrubbing.current) return;
    const x = time * pps;
    if (x < el.scrollLeft || x > el.scrollLeft + el.clientWidth - 24) {
      el.scrollLeft = Math.max(0, x - el.clientWidth / 2);
      syncViewport();
    }
  }, [time, pps, syncViewport]);
  const lanes = Array.from({ length: layerCount(project) }, (_, track) => ({
    track,
  })).reverse();
  const selectedItem = [...project.clips, ...project.texts].find(
    (c) => c.id === selection?.id,
  );
  const menuItem = menu && [...project.clips, ...project.texts].find((c) => c.id === menu.id);
  const selectedLocked = selectionItems(project, selected).some((item) => isTrackLocked(project, item.track));
  const menuLocked = !!menuItem && isTrackLocked(project, menuItem.track);
  useEffect(() => {
    if (!menu) return;
    document.querySelector<HTMLElement>(".clip-context-menu button:not(:disabled)")?.focus();
    const dismiss = (event: PointerEvent) => {
      if (!(event.target as Element).closest?.(".clip-context-menu")) setMenu(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(null);
    };
    const scrollAway = () => setMenu(null);
    window.addEventListener("pointerdown", dismiss, true);
    window.addEventListener("keydown", escape);
    window.addEventListener("resize", scrollAway);
    window.addEventListener("scroll", scrollAway, true);
    return () => {
      window.removeEventListener("pointerdown", dismiss, true);
      window.removeEventListener("keydown", escape);
      window.removeEventListener("resize", scrollAway);
      window.removeEventListener("scroll", scrollAway, true);
    };
  }, [menu]);
  function openMenu(e: ReactMouseEvent<HTMLElement>, item: Clip | TextClip) {
    e.preventDefault();
    e.stopPropagation();
    if ((e.target as Element).closest(".trim-handle")) return;
    if (!selected.some((value) => value.id === item.id))
      select({ kind: "assetId" in item ? "clip" : "text", id: item.id });
    if (e.type === "dblclick" && content.current) {
      const clicked = roundFrame((e.clientX - content.current.getBoundingClientRect().left) / pps, project.fps);
      seek(clamp(clicked, item.start, endOf(item) - 1 / project.fps));
    }
    setMenu({
      id: item.id,
      x: Math.max(8, Math.min(e.clientX, window.innerWidth - 234)),
      y: Math.max(8, Math.min(e.clientY, window.innerHeight - 550)),
    });
  }
  function menuAction(action: MenuAction) {
    if (menuItem) onClipMenuAction(action, menuItem);
    setMenu(null);
  }
  function align(edge: "start" | "end", item?: Clip | TextClip) {
    const values = item && !selected.some((value) => value.id === item.id)
      ? [{ kind: "assetId" in item ? "clip" as const : "text" as const, id: item.id }] : selected;
    edit((p) => alignSelectionToPlayhead(p, values, time, edge));
    setMenu(null);
  }
  function isTransitionDrag(e: ReactDragEvent<HTMLElement>) {
    return !!draggingTransition || Array.from(e.dataTransfer.types ?? []).includes("application/cutline-transition");
  }
  function joinAt(track: number, clientX: number, clipId?: string) {
    const cursor = (clientX - content.current!.getBoundingClientRect().left) / pps;
    const joins = project.clips
      .filter((c) => c.track === track && transitionSource(project, c))
      .filter((c) => !clipId || c.id === clipId || transitionSource(project, c)?.id === clipId)
      .sort((a, b) => Math.abs(a.start - cursor) - Math.abs(b.start - cursor));
    const closest = joins[0];
    return closest && (clipId || Math.abs(closest.start - cursor) <= 28 / pps)
      ? closest : null;
  }
  function dropTransition(e: ReactDragEvent<HTMLElement>, incomingId: string | null) {
    e.preventDefault();
    e.stopPropagation();
    const raw = e.dataTransfer.getData("application/cutline-transition") || draggingTransition;
    const name = TRANSITIONS.find((t) => t.name === raw)?.name;
    setHoverJoinId(null);
    const incoming = project.clips.find((clip) => clip.id === incomingId);
    if (incoming && isTrackLocked(project, incoming.track)) return;
    if (name) onApplyTransition(incomingId, name);
  }
  const latest = useRef({ project, pps, snapping, time, seek });
  useEffect(() => {
    latest.current = { project, pps, snapping, time, seek };
  }, [project, pps, snapping, time, seek]);

  useEffect(() => {
    let frame = 0;
    const update = () => {
      const d = dragging.current,
        scrub = scrubbing.current,
        viewport = scroll.current;
      if (d && !d.moved && Math.hypot(d.currentX - d.x, d.currentY - d.y) < 3)
        return;
      if ((d || scrub) && viewport) {
        const x = (d ?? scrub)!.currentX;
        const rect = viewport.getBoundingClientRect();
        const moved = d || (scrub && Math.abs(scrub.currentX - scrub.x) >= 3);
        if (moved && x > rect.right - 48)
          viewport.scrollLeft += clamp((x - rect.right + 48) / 5, 2, 24);
        else if (moved && x < rect.left + 48)
          viewport.scrollLeft -= clamp((rect.left + 48 - x) / 5, 2, 24);
        syncViewport();
        if (scrub && content.current) {
          const { project: p, pps: scale, seek: movePlayhead } = latest.current;
          movePlayhead(Math.max(0, roundFrame(
            (clamp(x, rect.left, rect.right) - content.current.getBoundingClientRect().left) / scale,
            p.fps,
          )));
          return;
        }
      }
      if (d && viewport) {
        d.moved = true;
        const {
          project: p,
          pps: scale,
          snapping: snap,
          time: playhead,
        } = latest.current;
        const rect = viewport.getBoundingClientRect();
        if (d.currentY > rect.bottom - 24)
          viewport.scrollTop += Math.max(
            2,
            (d.currentY - rect.bottom + 24) / 5,
          );
        else if (d.currentY < rect.top + 40)
          viewport.scrollTop -= Math.max(2, (rect.top + 40 - d.currentY) / 5);
        const delta = roundFrame(
          (d.currentX - d.x + viewport.scrollLeft - d.scroll) / scale,
          p.fps,
        );
        const movingIds = new Set(d.group.map((item) => item.id));
        const points = [
          0,
          playhead,
          ...p.markers.map((marker) => marker.time),
          ...[...p.clips, ...p.texts]
            .filter((i) => !movingIds.has(i.id))
            .flatMap((i) => [i.start, endOf(i)]),
        ];
        const length =
          "sourceEnd" in d.item ? clipDuration(d.item) : d.item.duration;
        let item = { ...d.item };
        if (d.type === "move") {
          const snapped = snapPosition(
            d.item.start + delta,
            length,
            points,
            7 / scale,
            snap && !d.alt && delta !== 0,
            p.fps,
          );
          item.start = delta === 0 ? d.item.start : snapped.position;
          setGuide(snapped.guide);
          const lane = [
            ...content.current!.querySelectorAll<HTMLElement>("[data-lane]"),
          ].find((el) => {
            const r = el.getBoundingClientRect();
            return d.currentY >= r.top && d.currentY < r.bottom;
          });
          if (lane) item.track = Number(lane.dataset.track);
        } else {
          const edge = d.type === "left" ? d.item.start : endOf(d.item);
          const snapped = snapPosition(
            edge + delta,
            0,
            points,
            7 / scale,
            snap && !d.alt && delta !== 0,
            p.fps,
          );
          const assetId = "assetId" in d.item ? d.item.assetId : null;
          item = trimItem(
            d.item,
            d.type,
            snapped.position - edge,
            p.assets.find((a) => a.id === assetId),
            p.fps,
          );
          setGuide(snapped.guide);
        }
        const trackDelta = Math.max(-Math.min(...d.group.map((member) => member.track)), item.track - d.item.track);
        const moveDelta = Math.max(-Math.min(...d.group.map((member) => member.start)), item.start - d.item.start);
        const movedGroup = d.type === "move" && d.group.length > 1
          ? d.group.map((member) => ({ ...member,
              start: member.start + moveDelta,
              track: member.track + trackDelta,
            })) : [item];
        if (d.group.some((member) => isTrackLocked(p, member.track)) || movedGroup.some((member) => isTrackLocked(p, member.track))) {
          setGuide(null);
          return;
        }
        const serialized = JSON.stringify(movedGroup);
        if (serialized !== d.last) {
          d.last = serialized;
          dispatch({
            type: "preview",
            fn: (current) => {
              const changes = new Map(movedGroup.map((member) => [member.id, member]));
              return { ...current,
                clips: current.clips.map((c) => changes.get(c.id) as Clip ?? c),
                texts: current.texts.map((t) => changes.get(t.id) as TextClip ?? t),
              };
            },
          });
        }
      }
    };
    updateDrag.current = update;
    const tick = () => {
      update();
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") scrubbing.current = null;
      if (e.key === "Escape" && dragging.current) {
        dragging.current = null;
        dispatch({ type: "cancel" });
        setGuide(null);
      }
    };
    window.addEventListener("keydown", escape);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", escape);
    };
  }, [dispatch, syncViewport]);
  function begin(
    e: ReactPointerEvent<HTMLElement>,
    item: Clip | TextClip,
    type: Drag["type"],
  ) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const kind = "assetId" in item ? "clip" : "text";
    if (e.shiftKey) {
      const exists = selected.some((s) => s.id === item.id);
      selectMany(exists ? selected.filter((s) => s.id !== item.id) : [...selected, { kind, id: item.id }]);
      return;
    }
    if (!selected.some((s) => s.id === item.id)) select({ kind, id: item.id });
    if (time < item.start || time >= endOf(item))
      seek(item.start + Math.min(0.1, (endOf(item) - item.start) / 2));
    else seek(time);
    const group = type === "move" && selected.some((s) => s.id === item.id) && selected.length > 1
      ? selectionItems(project, selected) : [item];
    if (group.some((member) => isTrackLocked(project, member.track))) return;
    dispatch({ type: "begin" });
    // The clip is reparented when changing layers. Capture on a stable ancestor
    // so the browser continues delivering pointer events throughout the drag.
    const capture = e.currentTarget.closest<HTMLElement>(".timeline")!;
    capture.setPointerCapture(e.pointerId);
    dragging.current = {
      item,
      group,
      type,
      kind,
      x: e.clientX,
      y: e.clientY,
      currentX: e.clientX,
      currentY: e.clientY,
      scroll: scroll.current!.scrollLeft,
      alt: e.altKey,
      element: capture,
      pointerId: e.pointerId,
      last: JSON.stringify(item),
      moved: false,
    };
  }
  const finish = (e: ReactPointerEvent<HTMLElement>) => {
    if (marqueeDrag.current) {
      const drag = marqueeDrag.current;
      drag.currentX = e.clientX;
      drag.currentY = e.clientY;
      const left = Math.min(drag.x, e.clientX), right = Math.max(drag.x, e.clientX);
      const top = Math.min(drag.y, e.clientY), bottom = Math.max(drag.y, e.clientY);
      const ids = Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 3
        ? [...content.current!.querySelectorAll<HTMLElement>(".timeline-clip")]
          .filter((el) => { const r = el.getBoundingClientRect(); return r.right >= left && r.left <= right && r.bottom >= top && r.top <= bottom; })
          .map((el) => el.dataset.clipId!) : [];
      const values = ids.map((id) => ({ kind: project.clips.some((c) => c.id === id) ? "clip" as const : "text" as const, id }));
      selectMany(values);
      if (drag.element.hasPointerCapture?.(drag.pointerId)) drag.element.releasePointerCapture(drag.pointerId);
      marqueeDrag.current = null;
      setMarquee(null);
      return;
    }
    if (scrubbing.current) {
      scrubbing.current.currentX = e.clientX;
      updateDrag.current();
      const scrub = scrubbing.current;
      scrubbing.current = null;
      if (scrub.element.hasPointerCapture?.(scrub.pointerId))
        scrub.element.releasePointerCapture(scrub.pointerId);
      return;
    }
    if (!dragging.current) return;
    dragging.current.currentX = e.clientX;
    dragging.current.currentY = e.clientY;
    dragging.current.alt = e.altKey;
    updateDrag.current();
    if (
      dragging.current.element.hasPointerCapture?.(dragging.current.pointerId)
    )
      dragging.current.element.releasePointerCapture(
        dragging.current.pointerId,
      );
    dragging.current = null;
    dispatch({ type: "commit" });
    setGuide(null);
  };
  function seekPointer(e: ReactPointerEvent<HTMLElement>) {
    const rect = content.current!.getBoundingClientRect();
    seek(Math.max(0, roundFrame((e.clientX - rect.left) / pps, project.fps)));
  }
  function beginScrub(e: ReactPointerEvent<HTMLElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    const capture = e.currentTarget.closest<HTMLElement>(".timeline")!;
    capture.setPointerCapture(e.pointerId);
    scrubbing.current = { x: e.clientX, currentX: e.clientX, element: capture, pointerId: e.pointerId };
    seekPointer(e);
  }
  function beginMarquee(e: ReactPointerEvent<HTMLElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    const capture = e.currentTarget.closest<HTMLElement>(".timeline")!;
    capture.setPointerCapture(e.pointerId);
    marqueeDrag.current = { x: e.clientX, y: e.clientY, currentX: e.clientX, currentY: e.clientY, pointerId: e.pointerId, element: capture };
    setMarquee({ x: e.clientX, y: e.clientY, width: 0, height: 0 });
  }
  const rulerStep = pps >= 80 ? 1 : pps >= 35 ? 2 : pps >= 18 ? 5 : 10;
  // Only render visible ruler marks, even after scrolling far into empty space.
  const firstTick = Math.max(0, Math.floor(viewport.left / pps / rulerStep) - 1);
  const lastTick = Math.ceil((viewport.left + viewport.width) / pps / rulerStep) + 1;
  return (
    <section
      className="timeline"
      aria-label="Multitrack timeline"
      onPointerMove={(e) => {
        if (marqueeDrag.current) {
          const drag = marqueeDrag.current;
          drag.currentX = e.clientX;
          drag.currentY = e.clientY;
          setMarquee({ x: Math.min(drag.x, e.clientX), y: Math.min(drag.y, e.clientY), width: Math.abs(e.clientX - drag.x), height: Math.abs(e.clientY - drag.y) });
        }
        if (scrubbing.current) scrubbing.current.currentX = e.clientX;
        const d = dragging.current;
        if (d) {
          d.currentX = e.clientX;
          d.currentY = e.clientY;
          d.alt = e.altKey;
        }
      }}
      onPointerUp={finish}
      onPointerCancel={() => {
        marqueeDrag.current = null;
        setMarquee(null);
        scrubbing.current = null;
        dragging.current = null;
        dispatch({ type: "cancel" });
        setGuide(null);
      }}
    >
      <div className="timeline-toolbar">
        <div className="tool-group">
          <button
            title="Undo · Ctrl Z"
            aria-label="Undo"
            disabled={!canUndo}
            onClick={() => dispatch({ type: "undo" })}
          >
            <Undo2 size={17} />
          </button>
          <button
            title="Redo · Ctrl Shift Z"
            aria-label="Redo"
            disabled={!canRedo}
            onClick={() => dispatch({ type: "redo" })}
          >
            <Redo2 size={17} />
          </button>
          <span className="divider" />
          <button
            title="Split at playhead · Ctrl B"
            aria-label="Split at playhead"
            disabled={!selection || selectedLocked}
            onClick={() => split()}
          >
            <Scissors size={17} />
          </button>
          <button
            title="Duplicate · Ctrl D"
            aria-label="Duplicate clip"
            disabled={!selection || selectedLocked}
            onClick={duplicate}
          >
            <Copy size={17} />
          </button>
          <button
            title="Delete · Del"
            aria-label="Delete clip"
            disabled={!selection || !selectionItems(project, selected).some((item) => !isTrackLocked(project, item.track))}
            onClick={() => remove()}
          >
            <Trash2 size={17} />
          </button>
          <span className="divider" />
          <button
            aria-label="Move to layer above"
            title="Move selected clip to the layer above"
            disabled={!selectedItem || isTrackLocked(project, selectedItem.track) || isTrackLocked(project, selectedItem.track + 1)}
            onClick={() =>
              selectedItem &&
              edit((p) => moveToLayer(p, selection, selectedItem.track + 1))
            }
          >
            <ArrowUp size={17} />
          </button>
          <button
            aria-label="Move to layer below"
            title="Move selected clip to the layer below"
            disabled={!selectedItem || isTrackLocked(project, selectedItem.track) || (selectedItem.track > 0 && isTrackLocked(project, selectedItem.track - 1))}
            onClick={() =>
              selectedItem &&
              edit((p) => moveToLayer(p, selection, selectedItem.track - 1))
            }
          >
            <ArrowDown size={17} />
          </button>
          <button aria-label="Move selection start to playhead" title="Move selected clips together so their earliest start meets the playhead" disabled={!selected.length || selectedLocked} onClick={() => align("start")}>
            <AlignStartHorizontal size={17} />
          </button>
          <button aria-label="Move selection end to playhead" title="Move selected clips together so their latest end meets the playhead" disabled={!selected.length || selectedLocked} onClick={() => align("end")}>
            <AlignEndHorizontal size={17} />
          </button>
        </div>
        <div className="tool-group timeline-options">
          <button
            className={snapping ? "active" : ""}
            title="Snap to clip edges, playhead, and beat/moment markers · hold Alt to bypass"
            aria-pressed={snapping}
            onClick={() => setSnapping(!snapping)}
          >
            <Magnet size={16} />
            <span>Snap</span>
          </button>
          <button
            className={ripple ? "active" : ""}
            title="Ripple delete closes the removed gap on its track"
            onClick={() => setRipple(!ripple)}
          >
            <span>Ripple delete</span>
          </button>
          <button
            className={hasBeatMarker ? "active timeline-marker-toolbar" : ""}
            aria-label="Mark beat"
            aria-pressed={hasBeatMarker}
            title="Mark or remove a beat at the playhead · M"
            onClick={() => edit((p) => toggleTimelineMarker(p, time, "beat"))}
          >
            <Flag size={15} />
            <span>Mark beat</span>
          </button>
          {onDetectBeats&&<button aria-label="Auto detect beats" title="Analyze audio and preview automatic beat markers" onClick={onDetectBeats}><AudioLines size={15}/><span>Auto beats</span></button>}
          <button
            className={hasMomentMarker ? "active timeline-marker-toolbar moment" : ""}
            aria-label="Mark moment"
            aria-pressed={hasMomentMarker}
            title="Mark or remove an important moment at the playhead · Shift M"
            onClick={() => edit((p) => toggleTimelineMarker(p, time, "moment"))}
          >
            <Bookmark size={15} />
            <span>Mark moment</span>
          </button>
        </div>
        <div className="tool-group zoom-tools">
          <span className="small-muted">Timeline</span>
          <button
            aria-label="Zoom out timeline"
            onClick={() => setPps((v) => Math.max(12, v / 1.3))}
          >
            <Minus size={15} />
          </button>
          <input
            aria-label="Timeline zoom"
            type="range"
            min="12"
            max="180"
            value={pps}
            onChange={(e) => setPps(+e.target.value)}
          />
          <button
            aria-label="Zoom in timeline"
            onClick={() => setPps((v) => Math.min(180, v * 1.3))}
          >
            <Plus size={15} />
          </button>
          <button
            onClick={() =>
              setPps(
                clamp(
                  (scroll.current?.clientWidth ?? 800) /
                    Math.max(10, duration + 2),
                  12,
                  180,
                ),
              )
            }
          >
            Fit
          </button>
        </div>
      </div>
      {marquee && <div className="timeline-marquee" style={{ left: marquee.x, top: marquee.y, width: marquee.width, height: marquee.height }} />}
      <div className="timeline-body">
        <div
          className="track-headers"
          ref={headers}
          onWheel={(e) => {
            if (scroll.current) scroll.current.scrollTop += e.deltaY;
          }}
        >
          <div className="track-ruler">
            <details className="track-add">
              <summary>
                <Plus size={13} /> Layer <ChevronDown size={12} />
              </summary>
              <div className="popover">
                <button
                  onClick={() => edit((p) => insertLayer(p, layerCount(p)))}
                >
                  Add layer above
                </button>
                <button onClick={() => edit((p) => insertLayer(p, 0))}>
                  Add layer below
                </button>
              </div>
            </details>
          </div>
          <div className="track-markers" aria-hidden="true" />
          {lanes.map((l) => {
            const key = "layer:" + l.track,
              hidden = project.hiddenTracks.includes(key),
              muted = project.mutedTracks.includes(key),
              locked = isTrackLocked(project, l.track);
            return (
              <div key={key} className={`track-header lane-layer${locked ? " track-locked" : ""}`}>
                <span title="Any clip type. Higher layers appear in front.">
                  <Layers size={14} /> Layer {l.track + 1}
                </span>
                <div>
                  <button
                    title={locked ? "Unlock layer to edit its clips" : "Lock layer to protect its clips"}
                    aria-label={(locked ? "Unlock " : "Lock ") + key}
                    aria-pressed={locked}
                    className={locked ? "locked-active" : ""}
                    onClick={() => edit((p) => ({ ...p, lockedTracks: locked
                      ? (p.lockedTracks ?? []).filter((value) => value !== key)
                      : [...(p.lockedTracks ?? []), key] }))}
                  >
                    {locked ? <LockKeyhole size={13} /> : <LockKeyholeOpen size={13} />}
                  </button>
                  <button
                    title={hidden ? "Show track" : "Hide track"}
                    aria-label={(hidden ? "Show " : "Hide ") + key}
                    className={hidden ? "muted-active" : ""}
                    onClick={() =>
                      edit((p) => ({
                        ...p,
                        hiddenTracks: hidden
                          ? p.hiddenTracks.filter((k) => k !== key)
                          : [...p.hiddenTracks, key],
                      }))
                    }
                  >
                    {hidden ? <EyeOff size={13} /> : <Eye size={13} />}
                  </button>
                  <button
                    title={muted ? "Unmute track" : "Mute track"}
                    aria-label={(muted ? "Unmute " : "Mute ") + key}
                    className={muted ? "muted-active" : ""}
                    onClick={() =>
                      edit((p) => ({
                        ...p,
                        mutedTracks: muted
                          ? p.mutedTracks.filter((k) => k !== key)
                          : [...p.mutedTracks, key],
                      }))
                    }
                  >
                    {muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        <div
          className="timeline-scroll"
          ref={scroll}
          onScroll={(e) => {
            syncViewport();
            if (headers.current)
              headers.current.scrollTop = e.currentTarget.scrollTop;
          }}
          onWheel={(e) => {
            if (e.ctrlKey || e.metaKey) {
              e.preventDefault();
              setPps((v) => clamp(v * (e.deltaY > 0 ? 0.9 : 1.1), 12, 180));
            }
          }}
        >
          <div ref={content} className="timeline-content" style={{ width }}>
            <div
              className="ruler"
              role="slider"
              aria-label="Playhead"
              aria-valuemin={0}
              aria-valuemax={timelineEnd}
              aria-valuenow={time}
              aria-valuetext={clock(time, true, project.fps)}
              tabIndex={0}
              onPointerDown={beginScrub}
              onKeyDown={(e) => {
                if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                  e.preventDefault();
                  e.stopPropagation();
                  seek(
                    Math.max(
                      0,
                      time + (e.key === "ArrowRight" ? 1 : -1) / project.fps,
                    ),
                  );
                }
              }}
            >
              {Array.from(
                { length: lastTick - firstTick + 1 },
                (_, i) => (
                  <span key={firstTick + i} style={{ left: (firstTick + i) * rulerStep * pps }}>
                    {clock((firstTick + i) * rulerStep)}
                  </span>
                ),
              )}
            </div>
            <div className="ruler-markers" role="group" aria-label="Beat and moment markers">
              {project.markers.map((marker: TimelineMarker, index: number) => (
                <button
                  key={marker.id}
                  type="button"
                  className={`timeline-marker ${marker.kind}${marker.source==="auto"?" auto":""}`}
                  style={{ left: marker.time * pps }}
                  aria-label={`Go to ${marker.kind === "beat" ? "beat" : "important moment"} ${index + 1} at ${clock(marker.time, true, project.fps)}; Delete or right-click to remove`}
                  title={`${marker.source==="auto"?`Auto beat${marker.bpm?` · ${marker.bpm} BPM`:""}`:marker.kind === "beat" ? "Beat" : "Moment"} · ${clock(marker.time, true, project.fps)} · click to seek, Delete or right-click to remove`}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => seek(marker.time)}
                  onKeyDown={(event) => {
                    if (event.key === "Delete" || event.key === "Backspace") {
                      event.preventDefault();
                      event.stopPropagation();
                      edit((p) => ({ ...p, markers: p.markers.filter((item) => item.id !== marker.id) }));
                    }
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    edit((p) => ({ ...p, markers: p.markers.filter((item) => item.id !== marker.id) }));
                  }}
                >
                  <i aria-hidden="true" />
                </button>
              ))}
            </div>
            {lanes.map((l) => {
              const key = "layer:" + l.track;
              const locked = isTrackLocked(project, l.track);
              const items = [...project.clips, ...project.texts]
                .filter((c) => c.track === l.track)
                .sort((a, b) => a.start - b.start);
              return (
                <div
                  key={key}
                  data-lane={key}
                  data-kind="layer"
                  data-track={l.track}
                  className={
                    "timeline-lane lane-layer" +
                    (project.hiddenTracks.includes(key) ? " track-hidden" : "")
                    + (locked ? " track-locked" : "")
                  }
                  style={{ backgroundSize: pps * rulerStep + "px 100%" }}
                  onPointerDown={(e) => {
                    if (e.target === e.currentTarget) {
                      beginMarquee(e);
                    }
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    if (locked) { e.dataTransfer.dropEffect = "none"; return; }
                    if (isTransitionDrag(e)) {
                      const join = joinAt(l.track, e.clientX);
                      setHoverJoinId(join?.id ?? null);
                      e.dataTransfer.dropEffect = join ? "copy" : "none";
                    } else e.dataTransfer.dropEffect = "copy";
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (locked) return;
                    if (isTransitionDrag(e)) {
                      dropTransition(e, joinAt(l.track, e.clientX)?.id ?? null);
                      return;
                    }
                    const asset = project.assets.find(
                      (a) =>
                        a.id ===
                        e.dataTransfer.getData("application/cutline-asset"),
                    );
                    if (!asset) return;
                    const start = Math.max(
                      0,
                      roundFrame(
                        (e.clientX -
                          content.current!.getBoundingClientRect().left) /
                          pps,
                        project.fps,
                      ),
                    );
                    const c = makeClip(
                      asset,
                      snapping
                        ? snapPosition(
                            start,
                            asset.duration,
                            [
                              0,
                              time,
                              ...project.markers.map((marker) => marker.time),
                              ...[...project.clips, ...project.texts].flatMap(
                                (c) => [c.start, endOf(c)],
                              ),
                            ],
                            8 / pps,
                            true,
                            project.fps,
                          ).position
                        : start,
                      l.track,
                    );
                    edit((p) => ({ ...p, clips: [...p.clips, c] }));
                    select({ kind: "clip", id: c.id });
                    seek(c.start);
                  }}
                >
                  {!items.length && (
                    <span className="lane-hint">
                      Any clip · video, text, image or audio
                    </span>
                  )}
                  {items.map((item) => {
                    const clip = "assetId" in item ? item : null,
                      asset = clip
                        ? project.assets.find((a) => a.id === clip.assetId)
                        : null;
                    const isSelected = selected.some((s) => s.id === item.id);
                    const clipLeft = item.start * pps;
                    const clipWidth = Math.max(1, (endOf(item) - item.start) * pps);
                    // Render only the visible part of a long clip. Each drawn
                    // sample remains ~2 screen pixels wide at every zoom level.
                    const waveLeft = clamp(Math.floor((viewport.left - clipLeft - 128) / 256) * 256, 0, clipWidth);
                    const waveRight = clamp(Math.ceil((viewport.left + viewport.width - clipLeft + 128) / 256) * 256, 0, clipWidth);
                    return (
                      <div
                        key={item.id}
                        data-clip-id={item.id}
                        role="button"
                        tabIndex={0}
                        aria-label={
                          ("text" in item ? item.text : item.label) +
                          ", starts " +
                          clock(item.start, true) +
                          ", duration " +
                          clock(endOf(item) - item.start, true)
                        }
                        title={
                          ("text" in item ? item.text : item.label) +
                          (locked ? "\nLayer locked · unlock to edit" : "\nDrag to move • drag edges to trim • Alt bypasses snap")
                        }
                        className={
                          "timeline-clip clip-" +
                          (clip?.kind ?? "text") +
                          (isSelected ? " selected" : "") +
                          (asset?.kind === "demo" ? " demo-" + asset.theme : "")
                        }
                        style={{
                          left: clipLeft,
                          width: clipWidth,
                          backgroundImage: asset?.thumbnail
                            ? 'url("' + asset.thumbnail + '")'
                            : undefined,
                        }}
                        onPointerDown={(e) => begin(e, item, "move")}
                        onDragOver={(e) => {
                          if (!clip || !isTransitionDrag(e)) return;
                          e.preventDefault();
                          e.stopPropagation();
                          if (locked) { e.dataTransfer.dropEffect = "none"; return; }
                          const join = joinAt(clip.track, e.clientX, clip.id);
                          setHoverJoinId(join?.id ?? null);
                          e.dataTransfer.dropEffect = join ? "copy" : "none";
                        }}
                        onDrop={(e) => {
                          if (!clip || !isTransitionDrag(e)) return;
                          dropTransition(e, joinAt(clip.track, e.clientX, clip.id)?.id ?? null);
                        }}
                        onDoubleClick={(e) => openMenu(e, item)}
                        onContextMenu={(e) => openMenu(e, item)}
                        onKeyDown={(e) => {
                          if (e.key === "F10" && e.shiftKey) {
                            e.preventDefault();
                            select({ kind: clip ? "clip" : "text", id: item.id });
                            const rect = e.currentTarget.getBoundingClientRect();
                            setMenu({ id: item.id, x: Math.max(8, Math.min(rect.left + 12, window.innerWidth - 234)), y: Math.max(8, Math.min(rect.bottom, window.innerHeight - 550)) });
                            return;
                          }
                          if (e.key === "Enter") {
                            select({
                              kind: clip ? "clip" : "text",
                              id: item.id,
                            });
                            seek(item.start);
                          }
                        }}
                      >
                        {clip?.kind === "audio" && waveRight > waveLeft && (
                          <Waveform
                            values={asset?.waveform}
                            peaks={asset?.waveformPeaks}
                            left={waveLeft}
                            width={waveRight - waveLeft}
                            sourceStart={clip.sourceStart + waveLeft / clipWidth * (clip.sourceEnd - clip.sourceStart)}
                            sourceEnd={clip.sourceStart + waveRight / clipWidth * (clip.sourceEnd - clip.sourceStart)}
                            duration={asset?.duration}
                          />
                        )}
                        <span className="clip-title">
                          {!clip ? (
                            <Type size={12} />
                          ) : clip.kind === "audio" ? (
                            <Music2 size={12} />
                          ) : (
                            <Film size={12} />
                          )}
                          {"text" in item ? item.text : item.label}
                        </span>
                        {(clip || item.effects?.length > 0) && (
                          <span className="clip-badges">
                            {clip?.frozenAt !== undefined && <b>Freeze</b>}
                            {clip && clip.speed !== 1 && <b>{clip.speed}×</b>}
                            {item.effects?.length > 0 && (
                              <b>FX {item.effects.length}</b>
                            )}
                            {clip && clip.filter !== "Original" && (
                              <b>{clip.filter}</b>
                            )}
                          </span>
                        )}
                        {[...(clip?.keyframes ?? []).map((k) => k.time), ...Object.values(item.propertyKeyframes ?? {}).flatMap((keys) => keys.map((key) => key.time))]
                          .filter((keyTime, i, keys) => keyTime >= 0 && keyTime <= endOf(item) - item.start && keys.indexOf(keyTime) === i)
                          .map((keyTime, i) => (
                            <i
                              key={i}
                              className="keyframe-mark"
                              style={{ left: keyTime * pps }}
                            />
                          ))}
                        <span
                          role="slider"
                          tabIndex={isSelected ? 0 : -1}
                          aria-label="Trim start"
                          aria-disabled={locked}
                          aria-valuenow={item.start}
                          className="trim-handle left"
                          onPointerDown={(e) => begin(e, item, "left")}
                        />
                        <span
                          role="slider"
                          tabIndex={isSelected ? 0 : -1}
                          aria-label="Trim end"
                          aria-disabled={locked}
                          aria-valuenow={endOf(item)}
                          className="trim-handle right"
                          onPointerDown={(e) => begin(e, item, "right")}
                        />
                      </div>
                    );
                  })}
                  {project.clips
                    .filter((c) => c.track === l.track && transitionSource(project, c))
                    .map((incoming) => {
                      const previous = transitionSource(project, incoming)!;
                      const window = transitionWindow(project, incoming);
                      return (
                        <div key={`join-${incoming.id}`}>
                        {window && <span className="transition-span" style={{ left: window.start * pps, width: window.duration * pps }} title={`${incoming.transition} between ${previous.label} and ${incoming.label}`} />}
                        <button
                          type="button"
                          disabled={locked}
                          className={
                            "transition-join" +
                            (incoming.transition !== "None" ? " applied" : "") +
                            (draggingTransition ? " drag-ready" : "") +
                            (draggingTransition && hoverJoinId === incoming.id ? " drag-over" : "")
                          }
                          style={{ left: incoming.start * pps }}
                          aria-label={`Transition between ${previous.label} and ${incoming.label}`}
                          title={incoming.transition === "None"
                            ? `Add transition between ${previous.label} and ${incoming.label}`
                            : `${incoming.transition} · ${incoming.transitionDuration}s — click to edit or drop another transition`}
                          onClick={() => onOpenTransitions(incoming.id)}
                          onDragOver={(e) => {
                            if (!isTransitionDrag(e)) return;
                            e.preventDefault();
                            e.stopPropagation();
                            setHoverJoinId(incoming.id);
                            e.dataTransfer.dropEffect = "copy";
                          }}
                          onDrop={(e) => {
                            if (isTransitionDrag(e)) dropTransition(e, incoming.id);
                          }}
                        >
                          {incoming.transition === "None" ? <Plus size={13} /> : <span>◐</span>}
                        </button>
                        </div>
                      );
                    })}
                </div>
              );
            })}
            {guide !== null && (
              <div className="snap-guide" style={{ left: guide * pps }} />
            )}
            <div className="playhead" style={{ left: time * pps }}>
              <span />
            </div>
            <div className="project-end" style={{ left: duration * pps }} />
          </div>
        </div>
      </div>
      <div className="timeline-footer">
        <span>
          {project.clips.length + project.texts.length} clips <i />{" "}
          {project.fps} fps <i /> {clock(duration, true, project.fps)}
        </span>
        <span>
          Higher layers appear in front · drag any clip between layers
        </span>
      </div>
      {menu && menuItem && createPortal(
        <div
          className="clip-context-menu"
          role="menu"
          tabIndex={-1}
          aria-label={`Clip actions for ${menuItem.label}`}
          style={{ left: menu.x, top: menu.y }}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setMenu(null); } }}
        >
          <div className="clip-menu-heading" title={menuItem.label}>{menuItem.label}</div>
          <button role="menuitem" onClick={() => menuAction("copy")}><Copy size={15} />Copy <kbd>Ctrl C</kbd></button>
          <button role="menuitem" disabled={!hasClipboard || menuLocked} onClick={() => menuAction("paste")}><ClipboardPaste size={15} />Paste at playhead <kbd>Ctrl V</kbd></button>
          <button role="menuitem" disabled={menuLocked} onClick={() => menuAction("duplicate")}><Copy size={15} />Duplicate <kbd>Ctrl D</kbd></button>
          <div className="clip-menu-divider" />
          <button role="menuitem" disabled={menuLocked} onClick={() => menuAction("split")}><Scissors size={15} />Split at playhead <kbd>Ctrl B</kbd></button>
          {"assetId" in menuItem && menuItem.kind === "video" && project.assets.find((a) => a.id === menuItem.assetId)?.kind === "video" && menuItem.frozenAt === undefined &&
            <button role="menuitem" disabled={menuLocked} onClick={() => menuAction("freeze")}><Snowflake size={15} />Freeze frame <kbd>2 sec</kbd></button>}
          {"assetId" in menuItem && menuItem.kind === "video" && project.assets.find((asset) => asset.id === menuItem.assetId)?.kind === "video" && menuItem.frozenAt === undefined &&
            <button role="menuitem" disabled={menuLocked} onClick={() => menuAction("detach-audio")}><Music2 size={15} />Detach audio</button>}
          <button role="menuitem" disabled={menuLocked || selectedLocked} onClick={() => align("start", menuItem)}><AlignStartHorizontal size={15} />Move selection start to playhead</button>
          <button role="menuitem" disabled={menuLocked || selectedLocked} onClick={() => align("end", menuItem)}><AlignEndHorizontal size={15} />Move selection end to playhead</button>
          <div className="clip-menu-divider" />
          <button role="menuitem" disabled={menuLocked || isTrackLocked(project, menuItem.track + 1)} onClick={() => { edit((p) => moveToLayer(p, { kind: "assetId" in menuItem ? "clip" : "text", id: menuItem.id }, menuItem.track + 1)); setMenu(null); }}><ArrowUp size={15} />Move to layer above</button>
          <button role="menuitem" disabled={menuLocked || (menuItem.track > 0 && isTrackLocked(project, menuItem.track - 1))} onClick={() => { edit((p) => moveToLayer(p, { kind: "assetId" in menuItem ? "clip" : "text", id: menuItem.id }, menuItem.track - 1)); setMenu(null); }}><ArrowDown size={15} />Move to layer below</button>
          <div className="clip-menu-divider" />
          <button role="menuitem" disabled={menuLocked} onClick={() => menuAction("delete")}><Trash2 size={15} />Delete <kbd>Del</kbd></button>
        </div>, document.body,
      )}
    </section>
  );
}
const Waveform = memo(function Waveform({ values, peaks, left, width, sourceStart, sourceEnd, duration }: {
  values?: number[];
  peaks?: number[];
  left: number;
  width: number;
  sourceStart: number;
  sourceEnd: number;
  duration?: number;
}) {
  const height = 36;
  const columns = values && duration
    ? waveformColumns(values, peaks, sourceStart, sourceEnd, duration, Math.ceil(width / 2))
    : [];
  const paths = columns.reduce((result, column, i) => {
    const x = ((i + 0.5) * width / columns.length).toFixed(1);
    if (column.peak > 0.002) {
      const half = Math.min(16, column.peak * 16);
      result.peak += `M${x} ${(18 - half).toFixed(1)}V${(18 + half).toFixed(1)}`;
    }
    if (column.rms > 0.002) {
      const half = Math.min(15, column.rms * 23);
      result.body += `M${x} ${(18 - half).toFixed(1)}V${(18 + half).toFixed(1)}`;
    }
    return result;
  }, { peak: "", body: "" });
  return columns.length ? (
    <svg
      className="waveform"
      style={{ left, width }}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path className="waveform-peaks" d={paths.peak} />
      <path className="waveform-body" d={paths.body} />
    </svg>
  ) : (
    <div className="audio-baseline" />
  );
});
