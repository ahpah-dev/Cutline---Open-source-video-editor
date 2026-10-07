"use client";
/* eslint-disable @next/next/no-img-element -- Local blob/data thumbnails must work offline in Electron without an image server. */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type CSSProperties,
} from "react";
import {
  Film,
  Music2,
  Type,
  Captions,
  Sparkles,
  Blend,
  Palette,
  Upload,
  Plus,
  Search,
  Download,
  ChevronDown,
  Check,
  X,
  Minus,
  Square,
  Maximize2,
  Minimize2,
  FolderOpen,
  FilePlus2,
  HardDrive,
  Keyboard,
  ArrowUpRight,
  Monitor,
  LoaderCircle,
  Scissors,
  Sticker,
  FolderArchive,
  ExternalLink,
  Layers2,
  Grip,
} from "lucide-react";
import { Timeline } from "./editor/Timeline";
import { Preview } from "./editor/Preview";
import { BeatDetectionDialog, beatSourceKey } from "./editor/BeatDetectionDialog";
import { applyBeatMarkers } from "./editor/beatDetection";
import { ThemePicker } from "./editor/ThemePicker";
import { Inspector, Field } from "./editor/Inspector";
import { CodexPanel } from "./editor/CodexPanel";
import { useCodex } from "./editor/useCodex";
import { EFFECTS, FILTERS, TEXT_PRESETS, TRANSITIONS } from "./editor/presets";
import {
  clamp,
  clipDuration,
  clock,
  endOf,
  freezeFrame,
  makeClip,
  makeText,
  newProject,
  parseSrt,
  projectDuration,
  setJoinTransition,
  splitItem,
  toggleTimelineMarker,
  transitionSource,
  uid,
  type Asset,
  type Clip,
  type Project,
  type Selection,
  type TextClip,
  type TransitionName,
} from "./editor/model";
import {
  exportFormats,
  exportProject,
  inspectFile,
  saveBlob,
} from "./editor/media";
import { useProject } from "./editor/useProject";
import { listProjects, type PersistedProject } from "./editorStorage";
import { decodeClipAudio, wordsToCaptions, type WhisperChunk } from "./editor/whisper";
import WhisperWorker from "./editor/whisper.worker?worker";
import { textAnimationTiming } from "./editor/textAnimation";
import { detachClipAudio, isTrackLocked, removeSelection, selectionItems } from "./editor/timelineOperations";
import { LibraryPreview } from "./editor/LibraryPreview";
import { pruneEffectKeyframes } from "./editor/effectStack";
const NAV = [
  { name: "Media", icon: Film },
  { name: "Audio", icon: Music2 },
  { name: "Text", icon: Type },
  { name: "Captions", icon: Captions },
  { name: "Stickers", icon: Sticker },
  { name: "Effects", icon: Sparkles },
  { name: "Transitions", icon: Blend },
  { name: "Filters", icon: Palette },
];

export default function Editor() {
  const [toast, setToast] = useState(""),
    toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notify = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 6500);
  }, []);
  const {
    project,
    ready,
    saveState,
    canUndo,
    canRedo,
    edit,
    dispatch,
    addMedia,
    load,
    restore,
    backup,
    importBackup,
  } = useProject(notify);
  const [selection, setSelection] = useState<Selection>(null),
    [selected, setSelected] = useState<NonNullable<Selection>[]>([]),
    [time, setTime] = useState(0),
    [playing, setPlaying] = useState(false);
  const select = useCallback((value: Selection) => {
    setSelection(value);
    setSelected(value ? [value] : []);
  }, []);
  const selectMany = useCallback((values: NonNullable<Selection>[]) => {
    setSelected(values);
    setSelection(values.at(-1) ?? null);
  }, []);
  const [library, setLibrary] = useState("Media"),
    [search, setSearch] = useState(""),
    [libraryCategory, setLibraryCategory] = useState("All"),
    [previewPreset, setPreviewPreset] = useState<string | null>(null),
    [ripple, setRipple] = useState(false),
    [draggingTransition, setDraggingTransition] = useState<TransitionName | null>(null),
    [busy, setBusy] = useState("");
  const [dialog, setDialog] = useState<"export" | "projects" | "help" | "subtitles" | null>(
      null,
    ),
    [archives, setArchives] = useState<PersistedProject[]>([]);
  const [subtitleClipId, setSubtitleClipId] = useState("");
  const [beatsOpen,setBeatsOpen]=useState(false);
  const [subtitleModel, setSubtitleModel] = useState("onnx-community/whisper-large-v3-ONNX");
  const [subtitleProgress, setSubtitleProgress] = useState<{ message: string; percent: number | null } | null>(null);
  const [subtitleError, setSubtitleError] = useState("");
  const subtitleWorker = useRef<Worker | null>(null);
  const subtitleRun = useRef(0);
  const subtitleReject = useRef<((error: Error) => void) | null>(null);
  const [desktop, setDesktop] = useState(false),
    [codexOpen, setCodexOpen] = useState(false),
    [maximized, setMaximized] = useState(false),
    [fullscreen, setFullscreen] = useState(false),
    [timelineHeight, setTimelineHeight] = useState(260);
  const [formats, setFormats] = useState<ReturnType<typeof exportFormats>>([]),
    [formatIndex, setFormatIndex] = useState(0),
    [resolution, setResolution] = useState(1080),
    [exportFps, setExportFps] = useState(30),
    [exportError, setExportError] = useState(""),
    [exporting, setExporting] = useState<{
      progress: number;
      phase: string;
    } | null>(null),
    [exportResult, setExportResult] = useState<{
      blob: Blob;
      name: string;
    } | null>(null);
  const abort = useRef<AbortController | null>(null),
    files = useRef<HTMLInputElement>(null),
    backupInput = useRef<HTMLInputElement>(null),
    captionsInput = useRef<HTMLInputElement>(null),
    clipboard = useRef<Clip | TextClip | null>(null);
  const [clipboardProjectId, setClipboardProjectId] = useState<string | null>(null);
  const hasClipboard = clipboardProjectId === project.id;
  const selectedClip =
    selection?.kind === "clip"
      ? project.clips.find((c) => c.id === selection.id)
      : undefined;
  const selectedText =
    selection?.kind === "text"
      ? project.texts.find((t) => t.id === selection.id)
      : undefined;
  const subtitleClip = project.clips.find((c) => c.id === subtitleClipId) ?? selectedClip ?? project.clips.find((c) => project.assets.some((a) => a.id === c.assetId && a.kind !== "image"));
  const openSubtitles = () => {
    const candidate = selectedClip && project.assets.some((a) => a.id === selectedClip.assetId && a.kind !== "image") ? selectedClip : project.clips.find((c) => project.assets.some((a) => a.id === c.assetId && a.kind !== "image"));
    if (!candidate) { notify("Add a video or audio clip to the timeline first."); return; }
    setSubtitleClipId(candidate.id);
    setSubtitleProgress(null);
    setSubtitleError("");
    setDialog("subtitles");
  };
  const cancelSubtitles = () => {
    subtitleRun.current++;
    subtitleReject.current?.(new Error("Transcription cancelled."));
    subtitleReject.current = null;
    subtitleWorker.current?.terminate();
    subtitleWorker.current = null;
    setSubtitleProgress(null);
    setSubtitleError("");
    setDialog(null);
  };
  const createAutoSubtitles = async () => {
    if (!subtitleClip || subtitleProgress) return;
    const asset = project.assets.find((a) => a.id === subtitleClip.assetId);
    if (!asset || asset.kind === "image") return;
    const run = ++subtitleRun.current;
    setSubtitleError("");
    setSubtitleProgress({ message: "Reading audio from your clip…", percent: null });
    try {
      const audio = await decodeClipAudio(subtitleClip, asset);
      if (run !== subtitleRun.current) return;
      if (audio.length < 1600) throw new Error("This clip has no usable audio.");
      const worker = new WhisperWorker();
      subtitleWorker.current = worker;
      const result = await new Promise<WhisperChunk[]>((resolve, reject) => {
        subtitleReject.current = reject;
        worker.onmessage = (event: MessageEvent<{ type: string; message?: string; progress?: number; chunks?: WhisperChunk[]; text?: string }>) => {
          const data = event.data;
          if (data.type === "status") setSubtitleProgress({ message: data.message ?? "Working…", percent: null });
          if (data.type === "progress") setSubtitleProgress({ message: "Downloading Whisper model…", percent: data.progress ?? null });
          if (data.type === "error") reject(new Error(data.message ?? "Transcription failed."));
          if (data.type === "done") {
            if (data.chunks?.length) resolve(data.chunks);
            else if (data.text?.trim()) resolve([{ text: data.text, timestamp: [0, audio.length / 16000] }]);
            else reject(new Error("Whisper detected no speech in this clip."));
          }
        };
        worker.onerror = (event) => reject(new Error(event.message || "Whisper could not start. Check your connection and try again."));
        worker.onmessageerror = () => reject(new Error("Whisper returned unreadable data. Please try again."));
        worker.postMessage({ audio, model: subtitleModel, runtimeUrl: new URL("./whisper-runtime/", document.baseURI).href }, [audio.buffer]);
      });
      if (run !== subtitleRun.current) return;
      const track = Math.max(project.layerCount, ...[...project.clips, ...project.texts].map((item) => item.track + 1));
      const captions = wordsToCaptions(result, subtitleClip.start, clipDuration(subtitleClip), track);
      if (!captions.length) throw new Error("Whisper found speech, but no timed captions could be created.");
      edit((p) => ({ ...p, layerCount: Math.max(p.layerCount, track + 1), texts: [...p.texts, ...captions] }));
      select({ kind: "text", id: captions[0].id });
      seek(captions[0].start);
      notify(`${captions.length} editable subtitles created locally.`);
      setDialog(null);
    } catch (error) {
      if (run === subtitleRun.current) {
        const message = (error as Error).message || "Auto subtitles failed. Please try again.";
        setSubtitleError(message);
        notify(message);
      }
    } finally {
      if (run === subtitleRun.current) {
        subtitleWorker.current?.terminate();
        subtitleWorker.current = null;
        subtitleReject.current = null;
        setSubtitleProgress(null);
      }
    }
  };
  const duration = projectDuration(project),
    matches = (name: string) =>
      name.toLowerCase().includes(search.trim().toLowerCase());
  const seek = useCallback((t: number) => {
    setPlaying(false);
    setTime(Math.max(0, t));
  }, []);
  const libraryCategories = library === "Effects"
    ? ["All", ...new Set(EFFECTS.map((preset) => preset.category))]
    : library === "Transitions" ? ["All", ...new Set(TRANSITIONS.map((preset) => preset.category))] : [];
  const visibleEffects = EFFECTS.filter((preset) => (libraryCategory === "All" || preset.category === libraryCategory) && matches(`${preset.name} ${preset.description} ${preset.category}`));
  const visibleTransitions = TRANSITIONS.filter((preset) => (libraryCategory === "All" || preset.category === libraryCategory) && matches(`${preset.name} ${preset.description} ${preset.category}`));
  const effectTarget = selectedText ?? (selectedClip?.kind === "video" ? selectedClip : undefined);
  useEffect(() => {
    const native = window.cutlineDesktop;
    if (!native) return;
    queueMicrotask(() => setDesktop(true));
    void native.isMaximized().then(setMaximized);
    void native.isFullscreen().then(setFullscreen);
    const stopMaximized = native.onMaximizedChange(setMaximized);
    const stopFullscreen = native.onFullscreenChange(setFullscreen);
    return () => {
      stopMaximized();
      stopFullscreen();
    };
  }, []);
  useEffect(() => {
    const changed = () => {
      if (!window.cutlineDesktop) setFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);
  const toggleEditorFullscreen = useCallback(() => {
    if (window.cutlineDesktop) window.cutlineDesktop.toggleFullscreen();
    else if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen().catch(() =>
      notify("Fullscreen is unavailable in this browser window."),
    );
  }, [notify]);
  const remove = useCallback((target: Selection = selection) => {
    if (!target) return;
    const targets = target.id === selection?.id && selected.length > 1 ? selected : [target];
    const items = selectionItems(project, targets);
    const locked = items.filter((item) => isTrackLocked(project, item.track));
    const next = removeSelection(project, targets, ripple);
    if (next === project) { notify("Unlock the layer to edit this clip."); return; }
    edit(() => next);
    selectMany(locked.map((item) => ({ kind: "assetId" in item ? "clip" : "text", id: item.id })));
    if (locked.length) notify(`${items.length - locked.length} clips deleted. Locked clips were kept.`);
  }, [selection, selected, project, edit, ripple, selectMany, notify]);
  const duplicate = useCallback(
    (atPlayhead = false, copied?: Clip | TextClip) => {
      const item = copied ?? selectedClip ?? selectedText;
      if (!item) return;
      if (isTrackLocked(project, item.track)) { notify("Unlock the layer to paste or duplicate here."); return; }
      const clone = {
        ...structuredClone(item),
        id: uid("assetId" in item ? "clip" : "text"),
        start: atPlayhead ? time : endOf(item),
      };
      if ("assetId" in clone) {
        edit((p) => ({ ...p, clips: [...p.clips, clone] }));
        select({ kind: "clip", id: clone.id });
      } else {
        edit((p) => ({ ...p, texts: [...p.texts, clone] }));
        select({ kind: "text", id: clone.id });
      }
      seek(clone.start);
    },
    [selectedClip, selectedText, project, time, edit, seek, select, notify],
  );
  const split = useCallback((target: Selection = selection) => {
    const item = target && [...project.clips, ...project.texts].find((value) => value.id === target.id);
    if (item && isTrackLocked(project, item.track)) { notify("Unlock the layer to split this clip."); return; }
    const result = splitItem(project, target, time);
    if (result.project === project) {
      notify("Place the playhead inside the selected clip to split it.");
      return;
    }
    edit(() => result.project);
    select(result.selection);
  }, [project, selection, time, edit, select, notify]);
  const freeze = useCallback((target: Selection) => {
    const item = target && project.clips.find((value) => value.id === target.id);
    if (item && isTrackLocked(project, item.track)) { notify("Unlock the layer to freeze this clip."); return; }
    const result = freezeFrame(project, target, time);
    if (result.project === project) {
      notify("Place the playhead inside a video clip to freeze its frame.");
      return;
    }
    edit(() => result.project);
    select(result.selection);
    seek(time);
    notify("2-second freeze frame added. Drag its edge to change the length.");
  }, [project, time, edit, select, seek, notify]);
  const detachAudio = useCallback((clip: Clip) => {
    const result = detachClipAudio(project, clip.id);
    if (result.project === project) {
      notify(isTrackLocked(project, clip.track) ? "Unlock the layer to detach audio." : "Select a video clip with audio to detach.");
      return;
    }
    edit(() => result.project);
    select(result.selection);
    seek(clip.start);
    notify("Audio detached to its own clip. The video's audio is muted.");
  }, [project, edit, select, seek, notify]);
  const copy = useCallback((item: Clip | TextClip) => {
    clipboard.current = structuredClone(item);
    setClipboardProjectId(project.id);
    notify("Clip copied. Paste it at the playhead.");
  }, [notify, project.id]);
  const openExport = useCallback(() => {
    setPlaying(false);
    setFormats(exportFormats());
    setFormatIndex(0);
    setExportFps(project.fps);
    setExportResult(null);
    setExportError("");
    setDialog("export");
  }, [project.fps]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "F11") {
        e.preventDefault();
        toggleEditorFullscreen();
        return;
      }
      if (
        (e.target instanceof Element && e.target.closest(
          'input, textarea, select, [contenteditable="true"], [role="menu"], dialog[open]',
        )) ||
        document.querySelector('dialog[open], [role="dialog"]') ||
        dialog ||
        busy
      )
        return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        setPlaying(false);
        dispatch({ type: e.shiftKey ? "redo" : "undo" });
      } else if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        dispatch({ type: "redo" });
      } else if (mod && e.key.toLowerCase() === "b") {
        e.preventDefault();
        split();
      } else if (mod && e.key.toLowerCase() === "d") {
        e.preventDefault();
        duplicate();
      } else if (
        mod &&
        e.key.toLowerCase() === "c" &&
        (selectedClip || selectedText)
      ) {
        e.preventDefault();
        copy((selectedClip ?? selectedText)!);
      } else if (mod && e.key.toLowerCase() === "v" && hasClipboard && clipboard.current) {
        e.preventDefault();
        duplicate(true, clipboard.current);
      } else if (mod && e.key.toLowerCase() === "e") {
        e.preventDefault();
        openExport();
      } else if (mod && e.key.toLowerCase() === "i") {
        e.preventDefault();
        files.current?.click();
      } else if (!mod && !e.altKey && e.key.toLowerCase() === "m") {
        e.preventDefault();
        if (!e.repeat) edit((p) => toggleTimelineMarker(p, time, e.shiftKey ? "moment" : "beat"));
      } else if (e.code === "Space") {
        e.preventDefault();
        if (time >= duration) setTime(0);
        setPlaying((v) => !v && duration > 0);
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        remove();
      } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        seek(
          Math.max(
            0,
            time +
              ((e.key === "ArrowRight" ? 1 : -1) * (e.shiftKey ? 10 : 1)) /
                project.fps,
          ),
        );
      } else if (e.key === "Home") {
        e.preventDefault();
        seek(0);
      } else if (e.key === "End") {
        e.preventDefault();
        seek(duration);
      } else if (e.key === "Escape") select(null);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [
    dispatch,
    split,
    duplicate,
    remove,
    seek,
    select,
    time,
    duration,
    project.fps,
    edit,
    selectedClip,
    selectedText,
    copy,
    hasClipboard,
    notify,
    dialog,
    busy,
    openExport,
    toggleEditorFullscreen,
  ]);
  async function importFiles(incoming: FileList | File[]) {
    if (busy || !ready) return;
    setBusy("Importing media");
    setPlaying(false);
    let count = 0;
    const errors: string[] = [];
    for (const file of Array.from(incoming)) {
      try {
        setBusy("Importing " + file.name);
        const asset = await inspectFile(file);
        await addMedia(asset, file);
        edit((p) => ({ ...p, assets: [...p.assets, asset] }));
        count++;
      } catch (error) {
        errors.push(file.name + ": " + (error as Error).message);
      }
    }
    setBusy("");
    setLibrary("Media");
    notify(
      errors.length
        ? errors.join(" · ")
        : count +
            " file" +
            (count === 1 ? "" : "s") +
            " imported. Drag media onto a track, or click + to add it.",
    );
  }
  function addAsset(asset: Asset) {
    const kind = asset.kind === "audio" ? "audio" : "video",
      track =
        project.clips.find((c) => c.kind === kind && !isTrackLocked(project, c.track))?.track ??
        (isTrackLocked(project, kind === "audio" ? 0 : 1) ? project.layerCount : kind === "audio" ? 0 : 1),
      start = Math.max(
        0,
        ...[...project.clips, ...project.texts]
          .filter((c) => c.track === track)
          .map(endOf),
      );
    const clip = makeClip(asset, start, track);
    edit((p) => ({ ...p, clips: [...p.clips, clip] }));
    select({ kind: "clip", id: clip.id });
    seek(start);
  }
  function addText(preset = TEXT_PRESETS[0]) {
    let track = Math.max(
      0,
      ...[...project.clips, ...project.texts]
        .filter(
          (c) => c.kind !== "audio" && endOf(c) > time && c.start < time + 4,
        )
        .map((c) => c.track + 1),
    );
    while (isTrackLocked(project, track)) track++;
    const text = makeText(time, {
      text: preset.sample,
      track,
      ...preset.style,
    });
    edit((p) => ({ ...p, texts: [...p.texts, text] }));
    select({ kind: "text", id: text.id });
    seek(time);
  }
  function applyTextPreset(preset: (typeof TEXT_PRESETS)[number]) {
    if (!selectedText) {
      addText(preset);
      return;
    }
    if (isTrackLocked(project, selectedText.track)) { notify("Unlock the layer to edit this text."); return; }
    const defaults = makeText(selectedText.start);
    edit((p) => ({
      ...p,
      texts: p.texts.map((t) =>
        t.id === selectedText.id
          ? {
              ...defaults,
              ...preset.style,
              id: t.id,
              text: t.text,
              start: t.start,
              duration: t.duration,
              track: t.track,
              x: t.x,
              y: t.y,
              effects: t.effects ?? [],
              exitAnimation: t.exitAnimation ?? "None",
              exitAnimationDuration: t.exitAnimationDuration ?? 0.5,
              fadeOut: t.fadeOut,
            }
          : t,
      ),
    }));
  }
  function applyVideo(patch: Partial<Clip>) {
    if (!selectedClip || selectedClip.kind !== "video") {
      notify("Select a video clip on the timeline first.");
      return;
    }
    if (isTrackLocked(project, selectedClip.track)) { notify("Unlock the layer to edit this clip."); return; }
    edit((p) => ({
      ...p,
      clips: p.clips.map((c) =>
        c.id === selectedClip.id ? { ...(patch.effects ? pruneEffectKeyframes(c, patch.effects) : c), ...patch } : c,
      ),
    }));
  }
  function applyJoinTransition(incomingId: string | null, name: TransitionName) {
    const incoming = project.clips.find((c) => c.id === incomingId);
    if (!incoming || (name !== "None" && !transitionSource(project, incoming))) {
      notify("Place two visual clips together on the same layer, then drop the transition on their join.");
      return;
    }
    if (isTrackLocked(project, incoming.track)) { notify("Unlock the layer to change its transition."); return; }
    edit((p) => setJoinTransition(p, incoming.id, name));
    select({ kind: "clip", id: incoming.id });
    seek(incoming.start + Math.min(0.15, incoming.transitionDuration / 2));
    notify(name === "None" ? "Transition removed." : `${name} transition added between the clips.`);
  }
  async function switchProject(p: Project) {
    try {
      setPlaying(false);
      await load(p);
      select(null);
      setTime(0);
      setDialog(null);
      notify("Project opened. Your previous edit is saved in My projects.");
    } catch (error) {
      notify((error as Error).message);
    }
  }
  async function makeBackup() {
    setBusy("Preparing project backup");
    try {
      const blob = await backup();
      if (await saveBlob(blob, safeName(project.name) + ".cutline"))
        notify("Project backup saved, including all imported media.");
    } catch (error) {
      notify((error as Error).message);
    } finally {
      setBusy("");
    }
  }
  async function startExport() {
    if (!formats[formatIndex]) return;
    setExportError("");
    const controller = new AbortController();
    abort.current = controller;
    setPlaying(false);
    setExporting({ progress: 0, phase: "Preparing media" });
    try {
      const format = formats[formatIndex];
      const blob = await exportProject(project, {
        resolution,
        fps: exportFps,
        mime: format.mime,
        signal: controller.signal,
        onProgress: (progress, phase) => setExporting({ progress, phase }),
      });
      const name = safeName(project.name) + "." + format.extension;
      setExportResult({ blob, name });
      setExporting(null);
      if (await saveBlob(blob, name)) notify("Video saved — no watermark.");
      else
        notify("Save cancelled. Your rendered video is still ready to save.");
    } catch (error) {
      setExporting(null);
      if ((error as Error).name !== "AbortError")
        setExportError((error as Error).message);
      notify(
        (error as Error).name === "AbortError"
          ? "Export cancelled. Your project is unchanged."
          : (error as Error).message,
      );
    } finally {
      abort.current = null;
    }
  }
  const codex = useCodex({ project, ready, blocked: !!busy || !!exporting || !!subtitleProgress || dialog === "projects", time, selected, canUndo, canRedo, edit, dispatch, seek, select, openExport });
  return (
    <main
      className={"editor-app" + (desktop ? " desktop-app" : "")}
      style={{ "--timeline-height": timelineHeight + "px" } as CSSProperties}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) e.preventDefault();
      }}
      onDrop={(e) => {
        if (e.dataTransfer.files.length) {
          e.preventDefault();
          void importFiles(e.dataTransfer.files);
        }
      }}
    >
      <header className="app-header">
        <div className="brand" aria-label="Cutline video editor">
          <span className="brand-mark">
            <Scissors size={21} strokeWidth={2.5} />
          </span>
          <span>cutline<span className="brand-dot">.</span></span>
        </div>
        <span className="header-divider" />
        <details
          className="project-menu"
          onClickCapture={(e) => {
            if (!ready || busy) {
              e.preventDefault();
              e.stopPropagation();
            }
          }}
        >
          <summary>
            <FolderOpen size={16} />
            <span>Project</span>
            <ChevronDown size={13} />
          </summary>
          <div className="popover">
            <button onClick={() => void switchProject(newProject())}>
              <FilePlus2 size={16} />
              New empty project
            </button>
            <button
              onClick={() => {
                void listProjects()
                  .then(setArchives)
                  .catch((e) => notify(e.message));
                setDialog("projects");
              }}
            >
              <FolderOpen size={16} />
              My projects
            </button>
            <hr />
            <button onClick={() => void makeBackup()}>
              <FolderArchive size={16} />
              Save project backup
            </button>
            <button onClick={() => backupInput.current?.click()}>
              <Upload size={16} />
              Open project backup
            </button>
            <hr />
            <button onClick={() => setDialog("help")}>
              <Keyboard size={16} />
              Shortcuts & editing guide
            </button>
          </div>
        </details>
        <div className="project-title">
          <input
            aria-label="Project name"
            value={project.name}
            spellCheck={false}
            onChange={(e) =>
              edit((p) => ({ ...p, name: e.target.value }), "project-name")
            }
          />
          <span>
            <span
              className={
                saveState.startsWith("Save failed")
                  ? "save-dot error"
                  : "save-dot"
              }
            />
            {saveState}
          </span>
        </div>
        <div className="header-actions">
          <ThemePicker />
          <button className={"button secondary codex-toggle" + (codexOpen ? " active" : "")} aria-pressed={codexOpen} onClick={() => setCodexOpen((value) => !value)} title="Edit your video with Codex">
            <Sparkles size={15} /> Codex
            {codex.status.connected && <i className="codex-status-dot" />}
          </button>
          <span className="local-badge">
            <HardDrive size={13} />
            On your device
          </span>
          <button
            className="button secondary editor-fullscreen-button"
            title={fullscreen ? "Exit full screen · F11" : "Full screen editor · F11"}
            aria-label={fullscreen ? "Exit full screen editor" : "Full screen editor"}
            onClick={toggleEditorFullscreen}
          >
            {fullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            <span>Full screen</span>
          </button>
          <button
            className="button secondary backup-button"
            title="Download a project backup, including source media"
            onClick={() => void makeBackup()}
            disabled={!ready || !!busy}
          >
            <FolderArchive size={15} />
            Backup
          </button>
          <button
            className="button primary"
            disabled={!ready || !!busy || !duration}
            onClick={openExport}
          >
            <Download size={16} />
            Export
            <ArrowUpRight size={14} />
          </button>
        </div>
        {desktop && (
          <div className="window-controls">
            <button
              title="Minimize"
              aria-label="Minimize window"
              onClick={() => window.cutlineDesktop?.minimize()}
            >
              <Minus size={15} />
            </button>
            <button
              title={maximized ? "Restore" : "Maximize"}
              aria-label="Maximize window"
              onClick={() => window.cutlineDesktop?.maximize()}
            >
              <Square size={13} />
            </button>
            <button
              className="window-close"
              title="Close"
              aria-label="Close window"
              onClick={() => window.cutlineDesktop?.close()}
            >
              <X size={17} />
            </button>
          </div>
        )}
      </header>
      <div className={"editing-workspace" + (codexOpen ? " codex-open" : "")}>
        <nav className="library-nav" aria-label="Editing tools">
          {NAV.map(({ name, icon: Icon }) => (
            <button
              key={name}
              className={library === name ? "active" : ""}
              aria-pressed={library === name}
              onClick={() => {
                setLibrary(name);
                setSearch("");
                setLibraryCategory("All");
                setPreviewPreset(null);
              }}
            >
              <Icon size={21} strokeWidth={1.7} />
              <span>{name}</span>
            </button>
          ))}
          <button
            className="help-nav"
            title="Editing guide"
            onClick={() => setDialog("help")}
          >
            <Keyboard size={19} />
            <span>Guide</span>
          </button>
        </nav>
        <aside className="library">
          <div className="panel-heading library-heading">
            <span>
              <span className="library-heading-copy"><strong>{library}</strong></span>
              <span className="subtle-badge">
                {library === "Effects"
                  ? EFFECTS.length
                  : library === "Transitions"
                    ? TRANSITIONS.length - 1
                    : library === "Filters"
                      ? FILTERS.length
                      : library === "Text"
                        ? TEXT_PRESETS.length
                        : library === "Captions"
                          ? project.texts.filter((text) => text.kind === "caption").length
                        : library === "Stickers"
                          ? 12
                        : library === "Audio"
                          ? project.assets.filter((a) => a.kind === "audio").length
                          : project.assets.length}
              </span>
            </span>
            {["Media", "Audio"].includes(library) && (
              <button
                aria-label="Import media"
                title="Import media · Ctrl I"
                onClick={() => files.current?.click()}
              >
                <Plus size={17} />
              </button>
            )}
          </div>
          <div className="library-search">
            <Search size={15} />
            <input
              aria-label={"Search " + library.toLowerCase()}
              placeholder={"Search " + library.toLowerCase() + "…"}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search ? <button className="search-clear" aria-label="Clear library search" onClick={() => setSearch("")}><X size={13} /></button> : null}
          </div>
          {libraryCategories.length ? <div className="library-categories" role="group" aria-label={`${library} categories`}>
            {libraryCategories.map((category) => <button key={category} className={libraryCategory === category ? "active" : ""} aria-pressed={libraryCategory === category} onClick={() => setLibraryCategory(category)}>{category}</button>)}
          </div> : null}
          <div className="library-content">
            {["Media", "Audio"].includes(library) && (
              <>
                <button
                  className="import-area"
                  disabled={!ready || !!busy}
                  onClick={() => files.current?.click()}
                >
                  <span>
                    <Upload size={19} />
                  </span>
                  <strong>
                    Import {library === "Audio" ? "audio" : "media"}
                  </strong>
                  <small>Click to browse or drop files here</small>
                  <span className="format-hint">
                    {library === "Audio"
                      ? "MP3 · WAV · M4A · OGG"
                      : "Video · images · audio"}
                  </span>
                </button>
                <div className="library-section-title">
                  <span>
                    {library === "Audio" ? "Your audio" : "Project media"}
                  </span>
                  <small>Drag to timeline</small>
                </div>
                <div className="asset-grid">
                  {project.assets
                    .filter(
                      (a) =>
                        (library !== "Audio" || a.kind === "audio") && matches(a.name),
                    )
                    .map((asset) => (
                      <div
                        className="asset-card"
                        key={asset.id}
                        draggable
                        onDragStart={(e) => {
                          e.dataTransfer.setData(
                            "application/cutline-asset",
                            asset.id,
                          );
                          e.dataTransfer.effectAllowed = "copy";
                        }}
                      >
                        <button
                          className={"asset-thumb demo-" + asset.theme}
                          title={"Add " + asset.name + " to timeline"}
                          aria-label={"Add " + asset.name + " to timeline"}
                          onClick={() => addAsset(asset)}
                        >
                          {asset.thumbnail ? (
                            <img
                              src={asset.thumbnail}
                              alt=""
                              draggable={false}
                            />
                          ) : asset.kind === "audio" ? (
                            <Music2 size={28} />
                          ) : (
                            <div className="demo-mountains" />
                          )}
                          <span className="asset-duration">
                            {clock(asset.duration)}
                          </span>
                          <span className="asset-add">
                            <Plus size={16} />
                          </span>
                        </button>
                        <strong title={asset.name}>{asset.name}</strong>
                        <small className="asset-meta"><span>{asset.kind === "audio" ? "Audio" : asset.kind === "image" ? "Image" : "Video"}</span><span>{asset.sizeLabel}</span></small>
                      </div>
                    ))}
                </div>
                {library === "Media" && project.assets.length === 0 && (
                  <div className="library-empty">
                    <Film size={26} />
                    <p>Your story starts here.</p>
                    <small>Import your videos, images, or audio to get started.</small>
                  </div>
                )}
                {library === "Audio" &&
                  !project.assets.some((a) => a.kind === "audio") && (
                    <div className="library-empty">
                      <Music2 size={26} />
                      <p>Your soundtrack starts here.</p>
                      <small>
                        Import a song, voiceover, or sound effect you have
                        permission to use.
                      </small>
                    </div>
                  )}
              </>
            )}
            {library === "Text" && (
              <>
                <button
                  className="button library-add primary"
                  onClick={() => addText()}
                >
                  <Plus size={16} />
                  Add text
                </button>
                <p className="library-description">
                  {selectedText
                    ? "Click a style to restyle the selected text."
                    : "Choose a style to add a new text layer."}
                </p>
                <div className="text-presets">
                  {TEXT_PRESETS.filter((p) => matches(p.name)).map((p) => (
                    <button
                      key={p.name}
                      className="text-preset"
                      onClick={() => applyTextPreset(p)}
                    >
                      <span
                        style={{
                          fontFamily: p.style.fontFamily,
                          fontWeight: p.style.fontWeight ?? 800,
                          fontStyle: p.style.italic ? "italic" : undefined,
                          color: p.style.color ?? "#fff",
                          ...(p.style.fillMode && p.style.fillMode !== "solid" ? {
                            backgroundImage: `linear-gradient(${(p.style.gradientAngle ?? 0) + 90}deg, ${(p.style.gradientStops ?? []).map((stop) => `${stop.color} ${stop.position * 100}%`).join(", ")})`,
                            backgroundClip: "text",
                            WebkitTextFillColor: "transparent",
                          } : {}),
                          textShadow:
                            p.name === "Neon"
                              ? "0 0 12px #35ffb6"
                              : p.name === "Bold outline" || p.name === "Retro"
                                ? "2px 2px 0 #72385b"
                                : undefined,
                          letterSpacing: p.style.letterSpacing
                            ? ".07em"
                            : undefined,
                        }}
                      >
                        {p.sample.split("\n")[0]}
                      </span>
                      <small>
                        {p.name}
                        <Plus size={12} />
                      </small>
                    </button>
                  ))}
                </div>
              </>
            )}
            {library === "Captions" && (
              <>
                <div className="caption-hero">
                  <Captions size={30} />
                  <h3>Every word, on screen.</h3>
                  <p>
                    Generate subtitles locally with Whisper, import an SRT, or write your own. Every caption stays editable.
                  </p>
                </div>
                <button className="button primary library-add" onClick={openSubtitles}>
                  <Sparkles size={16} /> Auto subtitles
                </button>
                <button
                  className="button secondary library-add"
                  onClick={() => captionsInput.current?.click()}
                >
                  <Upload size={16} />
                  Import SRT subtitles
                </button>
                <button
                  className="button secondary library-add"
                  onClick={() => addText(TEXT_PRESETS[4])}
                >
                  <Plus size={16} />
                  Add a caption
                </button>
                <div className="honest-note">
                  OpenAI Whisper runs on your device. Its free model downloads only after you confirm.
                </div>
              </>
            )}
            {library === "Stickers" && (
              <>
                <p className="library-description">
                  Simple symbols, fully editable. Add one, then change its
                  color, size, or animation in the inspector.
                </p>
                <div className="sticker-grid">
                  {[
                    "✦",
                    "☻",
                    "↗",
                    "★",
                    "♡",
                    "⚡",
                    "◉",
                    "✿",
                    "✓",
                    "∞",
                    "☀",
                    "✈",
                  ].map((symbol) => (
                    <button
                      key={symbol}
                      aria-label={"Add sticker " + symbol}
                      onClick={() =>
                        addText({
                          name: "Sticker",
                          sample: symbol,
                          style: {
                            kind: "sticker",
                            fontSize: 140,
                            fontFamily: "Arial",
                            shadowBlur: 0,
                          },
                        })
                      }
                    >
                      {symbol}
                    </button>
                  ))}
                </div>
              </>
            )}
            {library === "Effects" && (
              <>
                <div className="library-context"><Layers2 size={13} /><span>{effectTarget ? "On" : "Select a visual clip to apply"}</span>{effectTarget ? <strong title={effectTarget.label}>{effectTarget.label || "Text"}</strong> : null}{effectTarget?.effects.length ? <small>{effectTarget.effects.length} stacked</small> : null}</div>
                <div className="effect-grid">
                  {visibleEffects.map((effect) => {
                    const target = selectedText ?? selectedClip;
                    const active = target?.effects?.some(
                      (e) => e.name === effect.name,
                    );
                    return (
                      <button
                        key={effect.name}
                        className={"effect-card" + (active ? " active" : "")}
                        aria-label={`${effect.name} — ${effect.description}. ${active ? "Remove effect" : "Add effect"}`}
                        title={`${effect.name} — ${effect.description}`}
                        aria-pressed={active ?? false}
                        onPointerEnter={() => setPreviewPreset(`effect:${effect.name}`)}
                        onPointerLeave={() => setPreviewPreset(null)}
                        onFocus={() => setPreviewPreset(`effect:${effect.name}`)}
                        onBlur={() => setPreviewPreset(null)}
                        onClick={() => {
                          if (!target || target.kind === "audio") {
                            notify(
                              "Select a video or text clip on the timeline first.",
                            );
                            return;
                          }
                          if (isTrackLocked(project, target.track)) { notify("Unlock the layer to change effects."); return; }
                          const effects = active
                            ? (target.effects ?? []).filter(
                                (e) => e.name !== effect.name,
                              )
                            : [
                                ...(target.effects ?? []),
                                { name: effect.name, amount: effect.defaultAmount, ...(effect.name === "Wavy" ? { waves: 4 } : {}) },
                              ];
                          if (selectedText)
                            edit((p) => ({
                              ...p,
                              texts: p.texts.map((t) =>
                                t.id === selectedText.id
                                  ? { ...pruneEffectKeyframes(t, effects), effects }
                                  : t,
                              ),
                            }));
                          else applyVideo({ effects });
                        }}
                      >
                        <span className="preset-art" style={{ "--preset-accent": effect.color } as CSSProperties}>
                          <LibraryPreview kind="effect" name={effect.name} amount={effect.defaultAmount} animate={previewPreset === `effect:${effect.name}`} />
                          <span className={"preset-card-status" + (active ? " applied" : "")}><span>{active ? <Check size={12} /> : <Plus size={12} />}</span></span>
                        </span>
                        <span className="preset-copy"><strong>{effect.name}</strong><small>{effect.category}</small>{effect.name === "Strobe" ? <span className="flashing-effect-warning">Flashing effect</span> : null}</span>
                      </button>
                    );
                  })}
                </div>
                {!visibleEffects.length ? <div className="catalogue-empty"><Search size={22} /><strong>No effects found</strong><p>Try another search or category.</p><button onClick={() => { setSearch(""); setLibraryCategory("All"); }}>Reset filters</button></div> : null}
              </>
            )}
            {library === "Transitions" && (
              <>
                <div className="transition-drop-guide" aria-hidden="true"><span>A</span><i><Blend size={14} /></i><span>B</span><small>Drop on the join</small></div>
                <div className="transition-grid">
                  {visibleTransitions.map((t) => (
                    <button
                      key={t.name}
                      draggable
                      title={`${t.description}. Drag ${t.name} onto a clip join`}
                      aria-label={`${t.name} transition — drag to clip join`}
                      aria-pressed={selectedClip?.transition === t.name}
                      onPointerEnter={() => setPreviewPreset(`transition:${t.name}`)}
                      onPointerLeave={() => setPreviewPreset(null)}
                      onFocus={() => setPreviewPreset(`transition:${t.name}`)}
                      onBlur={() => setPreviewPreset(null)}
                      onDragStart={(e) => {
                        e.dataTransfer.setData("application/cutline-transition", t.name);
                        e.dataTransfer.setData("text/plain", t.name);
                        e.dataTransfer.effectAllowed = "copy";
                        setDraggingTransition(t.name);
                      }}
                      onDragEnd={() => setDraggingTransition(null)}
                      className={
                        "transition-card" +
                        (selectedClip?.transition === t.name ? " active" : "")
                      }
                      onClick={() => {
                        const incoming = selectedClip && (
                          transitionSource(project, selectedClip)
                            ? selectedClip
                            : project.clips.find((c) => transitionSource(project, c)?.id === selectedClip.id)
                        );
                        applyJoinTransition(incoming?.id ?? null, t.name);
                      }}
                    >
                      <span className="preset-art" style={{ "--preset-accent": t.color } as CSSProperties}>
                        <LibraryPreview kind="transition" name={t.name} animate={previewPreset === `transition:${t.name}`} />
                        {selectedClip?.transition === t.name ? <span className="preset-card-status applied"><span><Check size={12} /></span></span> : null}
                      </span>
                      <span className="preset-copy"><strong>{t.name}</strong><small>{t.category}</small></span>
                    </button>
                  ))}
                </div>
                {!visibleTransitions.length ? <div className="catalogue-empty"><Search size={22} /><strong>No transitions found</strong><p>Try another search or category.</p><button onClick={() => { setSearch(""); setLibraryCategory("All"); }}>Reset filters</button></div> : null}
              </>
            )}
            {library === "Filters" && (
              <>
                <p className="library-description">
                  One-click color looks. Fine-tune brightness, contrast, and
                  warmth under Color.
                </p>
                <div className="filter-grid">
                  {FILTERS.filter((f) => matches(f.name)).map((f) => (
                    <button
                      key={f.name}
                      className={
                        "filter-card" +
                        (selectedClip?.filter === f.name ? " active" : "")
                      }
                      onClick={() => applyVideo({ filter: f.name })}
                    >
                      <span
                        className="filter-art demo-alpine"
                        style={{ filter: f.css }}
                      >
                        <span className="demo-mountains" />
                        {selectedClip?.filter === f.name && (
                          <i>
                            <Check size={12} />
                          </i>
                        )}
                      </span>
                      <strong>{f.name}</strong>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
          <div className="library-footer">
            {library === "Effects" ? <><Layers2 size={12} />Click to stack · Hover to preview</> : library === "Transitions" ? <><Grip size={12} />Drag to a join · Set duration in inspector</> : <><HardDrive size={12} />Free to create. Yours to keep.</>}
          </div>
        </aside>
        <Preview
          project={project}
          selection={selection}
          select={select}
          time={time}
          setTime={setTime}
          seek={seek}
          playing={playing}
          setPlaying={setPlaying}
          dispatch={dispatch}
          onError={notify}
        />
        {codexOpen ? <CodexPanel codex={codex} desktop={desktop} ready={ready && !busy} canUndo={canUndo} undo={() => dispatch({ type: "undo" })} close={() => setCodexOpen(false)} /> : <Inspector
          focusEffects={library === "Effects"}
          project={project}
          selection={selection}
          time={time}
          edit={edit}
          clear={() => select(null)}
          previewAnimation={(phase, item) => {
            const timing = textAnimationTiming(item);
            setTime(phase === "Entrance" ? item.start : Math.max(item.start, endOf(item) - timing.exitDuration));
            setPlaying(true);
          }}
        />}
      </div>
      <div
        className="workspace-resizer"
        role="slider"
        aria-label="Resize timeline"
        aria-orientation="vertical"
        aria-valuemin={200}
        aria-valuemax={700}
        aria-valuenow={timelineHeight}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            setTimelineHeight((v) =>
              clamp(
                v + (e.key === "ArrowUp" ? 20 : -20),
                200,
                window.innerHeight - 300,
              ),
            );
          }
        }}
        onPointerDown={(e) => e.currentTarget.setPointerCapture(e.pointerId)}
        onPointerMove={(e) => {
          if (e.buttons === 1)
            setTimelineHeight(
              clamp(
                window.innerHeight - e.clientY,
                200,
                window.innerHeight - 300,
              ),
            );
        }}
      >
        <span />
      </div>
      <Timeline
        key={project.id}
        project={project}
        selection={selection}
        select={select}
        selected={selected}
        selectMany={selectMany}
        time={time}
        seek={seek}
        edit={edit}
        dispatch={dispatch}
        canUndo={canUndo}
        canRedo={canRedo}
        split={split}
        duplicate={() => duplicate()}
        remove={remove}
        draggingTransition={draggingTransition}
        onApplyTransition={applyJoinTransition}
        onOpenTransitions={(incomingId) => {
          select({ kind: "clip", id: incomingId });
          setLibrary("Transitions");
          setSearch("");
        }}
        hasClipboard={hasClipboard}
        onClipMenuAction={(action, item) => {
          const target: Selection = { kind: "assetId" in item ? "clip" : "text", id: item.id };
          if (action === "copy") copy(item);
          else if (action === "paste" && hasClipboard && clipboard.current) duplicate(true, clipboard.current);
          else if (action === "split") split(target);
          else if (action === "freeze") freeze(target);
          else if (action === "detach-audio" && "assetId" in item) detachAudio(item);
          else if (action === "duplicate") duplicate(false, item);
          else if (action === "delete") remove(target);
        }}
        ripple={ripple}
        setRipple={setRipple}
        onDetectBeats={()=>{setPlaying(false);setBeatsOpen(true);}}
      />
      {beatsOpen&&<BeatDetectionDialog key={project.id} project={project} initialClipId={selectedClip?.id} close={()=>setBeatsOpen(false)} seek={seek} apply={(clipId,key,times,bpm,replace)=>{
        const clip=project.clips.find(c=>c.id===clipId);
        if(!clip||beatSourceKey(project,clip)!==key){notify("Source timing changed. Reanalyze the audio first.");return;}
        edit(p=>applyBeatMarkers(p,clipId,times,bpm,replace));setBeatsOpen(false);notify("Beat markers added. Undo removes this batch.");
      }}/>}
      <input
        hidden
        type="file"
        ref={files}
        multiple
        accept="video/*,audio/*,image/*,.mkv,.mov,.m4a,.flac"
        onChange={(e) => {
          if (e.target.files) void importFiles(e.target.files);
          e.target.value = "";
        }}
      />
      <input
        hidden
        type="file"
        ref={backupInput}
        accept=".cutline,.zip"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          setBusy("Opening project backup");
          try {
            await importBackup(file);
            select(null);
            seek(0);
            notify("Project restored with its media.");
          } catch (error) {
            notify((error as Error).message);
          } finally {
            setBusy("");
          }
        }}
      />
      <input
        hidden
        type="file"
        ref={captionsInput}
        accept=".srt"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          try {
            const captions = parseSrt(await file.text());
            if (!captions.length)
              throw new Error(
                "No valid timed captions were found in this SRT file.",
              );
            const track = Math.max(
              0,
              ...[...project.clips, ...project.texts].map((t) => t.track + 1),
            );
            edit((p) => ({
              ...p,
              texts: [...p.texts, ...captions.map((t) => ({ ...t, track }))],
            }));
            select({ kind: "text", id: captions[0].id });
            seek(captions[0].start);
            notify(captions.length + " captions imported.");
          } catch (error) {
            notify((error as Error).message);
          }
        }}
      />
      {!!toast && (
        <div className="toast" role="status">
          <span>{toast}</span>
          <button
            aria-label="Dismiss notification"
            onClick={() => setToast("")}
          >
            <X size={15} />
          </button>
        </div>
      )}
      {(!ready || busy) && (
        <div className="busy-indicator" role="status">
          <LoaderCircle size={16} className="spin" />
          {busy || "Restoring your workspace"}
        </div>
      )}
      {dialog === "subtitles" && (
        <Dialog title="Auto subtitles" subtitle="Free, private speech-to-text with OpenAI Whisper" close={cancelSubtitles}>
          <div className="subtitle-dialog">
            <p>Whisper runs on this PC. Audio is not sent to a transcription service, and the selected model is cached locally after its first download.</p>
            <Field label="Timeline clip">
              <select value={subtitleClip?.id ?? ""} onChange={(e) => setSubtitleClipId(e.target.value)} disabled={!!subtitleProgress}>
                {project.clips.filter((c) => project.assets.some((a) => a.id === c.assetId && a.kind !== "image")).map((c) => <option value={c.id} key={c.id}>{c.label} · {clock(c.start)}–{clock(endOf(c))}</option>)}
              </select>
            </Field>
            <Field label="Whisper model">
              <select value={subtitleModel} onChange={(e) => setSubtitleModel(e.target.value)} disabled={!!subtitleProgress}>
                <option value="onnx-community/whisper-large-v3-ONNX">Multilingual · Large v3 (best accuracy, ~1 GB)</option>
                <option value="Xenova/whisper-tiny">Multilingual · Tiny</option>
                <option value="Xenova/whisper-tiny.en">English · Tiny</option>
              </select>
            </Field>
            <p className="field-note">{subtitleModel === "onnx-community/whisper-large-v3-ONNX" ? "Large v3 downloads about 1 GB once and uses your GPU; a WebGPU-capable graphics card is required." : "Tiny downloads approximately 50–100 MB and runs faster on modest PCs."} Transcription time depends on your clip length and PC. The generated captions are regular text clips, so you can fix any misheard words and style them.</p>
            {subtitleProgress && <div className="subtitle-progress" role="status"><LoaderCircle size={17} className="spin" /> {subtitleProgress.message}{subtitleProgress.percent !== null && ` ${Math.round(subtitleProgress.percent)}%`}</div>}
            {subtitleError && <div className="subtitle-error" role="alert">{subtitleError}</div>}
            <div className="dialog-actions">
              <button className="button secondary" onClick={cancelSubtitles}>{subtitleProgress ? "Cancel" : "Not now"}</button>
              <button className="button primary" disabled={!!subtitleProgress || !subtitleClip} onClick={() => void createAutoSubtitles()}><Download size={16} /> Download & transcribe</button>
            </div>
          </div>
        </Dialog>
      )}
      {dialog === "export" && (
        <Dialog
          title="Export your video"
          subtitle="Your edit. Full quality. No watermark."
          close={() => {
            if (exporting) abort.current?.abort();
            else setDialog(null);
          }}
        >
          {exporting ? (
            <div className="export-progress">
              <div className="export-orbit">
                <Monitor size={34} />
                <span className="spin">
                  <LoaderCircle size={74} strokeWidth={1} />
                </span>
              </div>
              <h3>{exporting.phase}</h3>
              <strong>
                {Math.round(exporting.progress * 100)}
                <span>%</span>
              </strong>
              <progress max="1" value={exporting.progress} />
              <p>
                Rendering happens in real time on your device. Keep this window
                open and your computer awake.
              </p>
              <button
                className="button secondary"
                onClick={() => abort.current?.abort()}
              >
                Cancel export
              </button>
            </div>
          ) : exportResult ? (
            <div className="export-success">
              <span>
                <Check size={34} />
              </span>
              <h3>Your video is ready.</h3>
              <p>
                {exportResult.name}
                <br />
                {(exportResult.blob.size / 1024 / 1024).toFixed(1)} MB ·
                watermark-free
              </p>
              <button
                className="button primary"
                onClick={() =>
                  void saveBlob(exportResult.blob, exportResult.name)
                    .then((saved) => {
                      if (saved) notify("Video saved.");
                    })
                    .catch((e) => notify(e.message))
                }
              >
                <Download size={16} />
                Save video again
              </button>
              <button
                className="button secondary"
                onClick={() => setDialog(null)}
              >
                Back to editing
              </button>
            </div>
          ) : (
            <>
              <div className="export-summary">
                <span>
                  <Film size={24} />
                </span>
                <div>
                  <strong>{project.name || "Untitled project"}</strong>
                  <small>
                    {clock(duration, true, project.fps)} · {project.ratio} ·{" "}
                    {project.clips.length + project.texts.length} clips
                  </small>
                </div>
                <span className="free-tag">FREE</span>
              </div>
              <div className="export-fields">
                <Field label="Format">
                  <select
                    value={formatIndex}
                    onChange={(e) => setFormatIndex(+e.target.value)}
                  >
                    {formats.map((f, i) => (
                      <option value={i} key={f.mime}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                </Field>
                <div className="field-grid">
                  <Field label="Resolution">
                    <select
                      value={resolution}
                      onChange={(e) => setResolution(+e.target.value)}
                    >
                      <option value="720">720p · faster</option>
                      <option value="1080">1080p · recommended</option>
                      <option value="2160">2160p · demanding</option>
                    </select>
                  </Field>
                  <Field label="Frame rate">
                    <select
                      value={exportFps}
                      onChange={(e) => setExportFps(+e.target.value)}
                    >
                      <option value="30">30 fps</option>
                      <option value="60">60 fps</option>
                    </select>
                  </Field>
                </div>
              </div>
              <div className="export-note">
                <HardDrive size={17} />
                <p>
                  Local, real-time encoding. Performance depends on your
                  computer; 4K, 60 fps, and stacked effects are more demanding.
                  Only supported formats are shown.
                </p>
              </div>
              {!formats.length && (
                <p className="error-message">
                  This browser has no supported video encoder. Open Cutline in
                  Chrome, Edge, or the PC app.
                </p>
              )}
              {exportError && (
                <p className="error-message" role="alert">
                  {exportError}
                </p>
              )}
              <div className="dialog-actions">
                <button
                  className="button secondary"
                  onClick={() => setDialog(null)}
                >
                  Cancel
                </button>
                <button
                  className="button primary"
                  disabled={!formats.length || !duration}
                  onClick={() => void startExport()}
                >
                  <Download size={16} />
                  Export video
                </button>
              </div>
            </>
          )}
        </Dialog>
      )}
      {dialog === "projects" && (
        <Dialog
          title="My projects"
          subtitle="Saved locally on this device and in this browser."
          close={() => setDialog(null)}
        >
          <div className="project-list">
            {archives.length === 0 && (
              <p className="library-description">
                Your current project will appear here after its first save.
              </p>
            )}
            {archives.map((p, i) => (
              <button
                key={"id" in p ? p.id : i}
                className="saved-project"
                onClick={() => void switchProject(restore(p))}
              >
                <span>
                  <Film size={21} />
                </span>
                <div>
                  <strong>{"name" in p ? p.name : p.projectName}</strong>
                  <small>
                    {new Date(p.updatedAt).toLocaleString()} ·{" "}
                    {p.clips.length + p.texts.length} clips
                  </small>
                </div>
                {"id" in p && p.id === project.id ? (
                  <Check size={17} />
                ) : (
                  <ExternalLink size={16} />
                )}
              </button>
            ))}
          </div>
          <div className="dialog-actions">
            <button
              className="button secondary"
              onClick={() => void switchProject(newProject())}
            >
              <Plus size={16} />
              New project
            </button>
            <button className="button primary" onClick={() => setDialog(null)}>
              Done
            </button>
          </div>
        </Dialog>
      )}
      {dialog === "help" && (
        <Dialog
          title="A smoother way to edit"
          subtitle="A few essentials to get you into your flow."
          close={() => setDialog(null)}
        >
          <div className="guide-content">
            <h3>Build your story</h3>
            <p>
              Every layer accepts video, text, images, and audio. Higher layers
              appear in front. Drag text below a video to put it behind, or use
              the up and down arrows. Add a layer above or below from the Layer
              menu. Drag clip edges to trim, and drag in the player to
              reposition.
            </p>
            <h3>Style & motion</h3>
            <p>
              Select video or text to apply effects. Transitions and color
              filters apply to video. Select text to restyle it. Add transform
              keyframes at different playhead positions to animate a video.
              Every adjustment supports undo.
            </p>
            <div className="shortcuts">
              {[
                ["Space", "Play / pause"],
                ["Ctrl B", "Split at playhead"],
                ["Ctrl D", "Duplicate"],
                ["Ctrl C / V", "Copy / paste at playhead"],
                ["Ctrl Z / Shift Z", "Undo / redo"],
                ["← / →", "Move one frame"],
                ["Shift ← / →", "Move ten frames"],
                ["Delete", "Delete selected clip"],
                ["M / Shift M", "Mark beat / important moment"],
                ["Alt + drag", "Ignore snapping"],
                ["Esc during drag", "Cancel the move"],
                ["Ctrl I", "Import media"],
                ["Ctrl E", "Export video"],
              ].map(([key, action]) => (
                <div key={key}>
                  <span>{action}</span>
                  <kbd>{key}</kbd>
                </div>
              ))}
            </div>
            <p className="honest-note">
              Media stays local. Browser storage is separate from the PC app;
              use a .cutline backup to transfer projects. Export is real-time.
              Use masks to shape or reveal a clip. Lock layers to protect edits,
              detach audio from a video, and snap clips to beat or moment markers.
            </p>
          </div>
        </Dialog>
      )}
    </main>
  );
}
function safeName(name: string) {
  return (name || "Cutline export").replace(/[<>:"/\\|?*]/g, "_").slice(0, 120);
}
function Dialog({
  title,
  subtitle,
  close,
  children,
}: {
  title: string;
  subtitle: string;
  close: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    closeRef = useRef(close);
  useEffect(() => {
    closeRef.current = close;
  }, [close]);
  useEffect(() => {
    const dialog = ref.current!;
    const previous = document.activeElement as HTMLElement;
    dialog.showModal();
    return () => {
      dialog.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        closeRef.current();
      }}
    >
      <div className="dialog-heading">
        <div>
          <h2>{title}</h2>
          <p>{subtitle}</p>
        </div>
        <button aria-label="Close dialog" onClick={close}>
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
