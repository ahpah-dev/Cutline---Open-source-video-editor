/* eslint-disable @next/next/no-img-element -- Small local source-frame previews work offline. */
import { useCallback, useEffect, useRef, useState } from "react";
import { ScanLine, X } from "lucide-react";
import { clipDuration, clock, type Project } from "./model";
import { DEFAULT_SCENE_SETTINGS, sceneSourceKey, type SceneCut } from "./sceneDetection";
import { scanScenes } from "./sceneMedia";
import { isTrackLocked } from "./timelineOperations";

type Props = { project: Project; initialClipId?: string; close: () => void; seek: (time: number) => void; apply: (clipId: string, key: string, times: number[], mode: "split" | "markers") => void };
export function SceneDetectionDialog({ project, initialClipId, close, seek, apply }: Props) {
  const candidates = project.clips.filter(clip => clip.kind === "video" && clip.frozenAt === undefined && !isTrackLocked(project, clip.track) && project.assets.some(asset => asset.id === clip.assetId && asset.kind === "video"));
  const [clipId, setClipId] = useState(() => candidates.find(clip => clip.id === initialClipId)?.id ?? candidates[0]?.id ?? "");
  const [settings, setSettings] = useState(DEFAULT_SCENE_SETTINGS);
  const [cuts, setCuts] = useState<SceneCut[] | null>(null), [excluded, setExcluded] = useState<Set<number>>(() => new Set());
  const [key, setKey] = useState(""), [progress, setProgress] = useState<number | null>(null), [error, setError] = useState("");
  const [mode, setMode] = useState<"split" | "markers">("split");
  const dialog = useRef<HTMLDialogElement>(null), controller = useRef<AbortController | null>(null);
  const stop = useCallback(() => { controller.current?.abort(); controller.current = null; }, []);
  useEffect(() => { const el = dialog.current!; el.showModal(); return () => { stop(); el.close(); }; }, [stop]);
  const clip = candidates.find(item => item.id === clipId), asset = project.assets.find(item => item.id === clip?.assetId);
  const stale = Boolean(cuts && (!clip || key !== sceneSourceKey(project, clip)));
  const selectedCuts = cuts?.filter(cut => !excluded.has(cut.time)) ?? [];
  const detect = async () => {
    if (!clip || !asset) return;
    stop(); const run = new AbortController(); controller.current = run;
    setKey(sceneSourceKey(project, clip)); setCuts(null); setExcluded(new Set()); setError(""); setProgress(0);
    try {
      const result = await scanScenes(clip, asset, project.fps, settings, run.signal, value => { if (!run.signal.aborted) setProgress(value); });
      if (!run.signal.aborted) setCuts(result);
    } catch (cause) { if (!run.signal.aborted) setError(cause instanceof Error ? cause.message : "Scene scan failed. Try another video."); }
    finally { if (!run.signal.aborted) { setProgress(null); controller.current = null; } }
  };
  return <dialog ref={dialog} className="beat-dialog scene-dialog" aria-labelledby="scene-title" onKeyDown={event => event.stopPropagation()} onCancel={event => { event.preventDefault(); close(); }}>
    <div className="beat-dialog-heading"><div><ScanLine size={22} /><div><h2 id="scene-title">Find the cuts</h2><p>Turn a finished video into editable shots.</p></div></div><button aria-label="Close scene detection" onClick={close}><X size={18} /></button></div>
    <label className="field">Video source<select aria-label="Scene detection source" value={clipId} disabled={progress !== null} onChange={event => { setClipId(event.target.value); setCuts(null); setError(""); }}>{candidates.map(item => <option key={item.id} value={item.id}>{item.label} · {clock(clipDuration(item))}</option>)}</select></label>
    <p className="field-note">Scans original footage inside this clip&apos;s trim, up to 10 minutes. Runs on your PC—no upload, model download or API key. Best for hard cuts; dissolves and very brief shots can be missed.</p>
    {!candidates.length && <p className="beat-error">Add a video clip on an unlocked layer first. Images and freeze frames do not have scene changes.</p>}
    <div className="beat-settings scene-settings">
      <label className="field">Detection sensitivity · {settings.sensitivity}<input aria-label="Scene detection sensitivity" type="range" min={0} max={100} value={settings.sensitivity} disabled={progress !== null} onChange={event => { setSettings(old => ({ ...old, sensitivity: Number(event.target.value) })); setCuts(null); }} /><small>Higher finds subtler changes.</small></label>
      <label className="field">Minimum scene length<select aria-label="Minimum scene length" value={settings.minimum} disabled={progress !== null} onChange={event => { setSettings(old => ({ ...old, minimum: Number(event.target.value) })); setCuts(null); }}><option value={.125}>0.125 seconds · fast edits</option><option value={.25}>0.25 seconds · short shots</option><option value={.5}>0.5 seconds · balanced</option><option value={1}>1 second · longer shots</option><option value={2}>2 seconds · fewer cuts</option></select></label>
    </div>
    <div className="beat-detect-row"><button className="button primary" disabled={!clip || progress !== null} onClick={() => void detect()}><ScanLine size={16} />{cuts ? "Scan again" : "Detect scene cuts"}</button>{progress !== null && <><progress aria-label="Scene scan progress" max={1} value={progress} /><span role="status">Scanning · {Math.round(progress * 100)}%</span><button className="button secondary" onClick={() => { stop(); setProgress(null); }}>Cancel scan</button></>}</div>
    {error && <p className="beat-error" role="alert">{error}</p>}
    {cuts && <>
      <div className="scene-results-heading"><div><strong>{cuts.length} cut{cuts.length === 1 ? "" : "s"} detected</strong><p>{selectedCuts.length} selected · nothing changed yet</p></div><button className="button secondary" onClick={() => setExcluded(excluded.size ? new Set() : new Set(cuts.map(cut => cut.time)))} disabled={!cuts.length}>{excluded.size ? "Select all" : "Deselect all"}</button></div>
      {!cuts.length && <p className="field-note">No clear cuts found. Try higher sensitivity, a shorter minimum scene length, or split manually at the playhead.</p>}
      <div className="scene-cut-list" aria-label="Detected scene cuts">{cuts.map((cut, index) => <div key={cut.time} className={`scene-cut${excluded.has(cut.time) ? " excluded" : ""}`}>
        <label><input type="checkbox" aria-label={`Include scene cut ${index + 1}`} checked={!excluded.has(cut.time)} onChange={() => setExcluded(old => { const next = new Set(old); if (next.has(cut.time)) next.delete(cut.time); else next.add(cut.time); return next; })} /><span>Cut {index + 1}<small>{clock((clip?.start ?? 0) + cut.time, true, project.fps)}</small></span></label>
        <button className="scene-cut-preview" title="Seek just before this cut" onClick={() => clip && seek(Math.max(clip.start, clip.start + cut.time - 1 / project.fps))}><img src={cut.before} alt={`Before cut ${index + 1}`} /><span>Before</span></button>
        <button className="scene-cut-preview" title="Seek to this cut" onClick={() => clip && seek(clip.start + cut.time)}><img src={cut.after} alt={`After cut ${index + 1}`} /><span>After</span></button>
      </div>)}</div>
      <label className="field scene-output">Apply as<select aria-label="Scene detection action" value={mode} onChange={event => setMode(event.target.value as "split" | "markers")}><option value="split">Split into editable clips</option><option value="markers">Moment markers only · leave clip intact</option></select></label>
      <p className="field-note">Splits keep source audio with each shot and preserve timing, effects and keyframes. Detached audio and other layers stay untouched. Applied as one undoable batch. Detection is an estimate; review before applying.</p>
      {stale && <p className="beat-error" role="alert">The clip changed or its layer was locked. Scan again before applying.</p>}
    </>}
    <div className="beat-dialog-actions"><button className="button secondary" onClick={close}>Close</button><button className="button primary" disabled={!clip || !cuts || !selectedCuts.length || stale || progress !== null} onClick={() => clip && apply(clip.id, key, selectedCuts.map(cut => cut.time), mode)}>{mode === "split" ? `Split at ${selectedCuts.length} cuts` : `Add ${selectedCuts.length} markers`}</button></div>
  </dialog>;
}
