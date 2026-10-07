import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AudioLines, X } from "lucide-react";
import { clipDuration, clock, type Clip, type Project } from "./model";
import { decodeClipAudio } from "./whisper";
import { beatTimes, DEFAULT_BEAT_SETTINGS, type BeatAnalysis, type BeatSettings } from "./beatDetection";

export const beatSourceKey=(project:Project,clip:Clip)=>JSON.stringify([project.id,clip.id,clip.assetId,clip.start,clip.sourceStart,clip.sourceEnd,clip.speed,project.assets.find(a=>a.id===clip.assetId)?.url]);
type Props={project:Project;initialClipId?:string;close:()=>void;seek:(time:number)=>void;apply:(clipId:string,key:string,times:number[],bpm:number,replace:boolean)=>void};
export function BeatDetectionDialog({project,initialClipId,close,seek,apply}:Props){
  const candidates=project.clips.filter(c=>project.assets.some(a=>a.id===c.assetId&&(a.kind==="audio"||a.kind==="video")));
  const [clipId,setClipId]=useState(candidates.some(c=>c.id===initialClipId)?initialClipId!:candidates.find(c=>c.kind==="audio")?.id||candidates[0]?.id||"");
  const [settings,setSettings]=useState<BeatSettings>(DEFAULT_BEAT_SETTINGS),[analysis,setAnalysis]=useState<BeatAnalysis|null>(null),[sourceKey,setSourceKey]=useState("");
  const [progress,setProgress]=useState<number|null>(null),[error,setError]=useState(""),[replace,setReplace]=useState(true);
  const dialog=useRef<HTMLDialogElement>(null),worker=useRef<Worker|null>(null),abort=useRef<AbortController|null>(null),generation=useRef(0);
  const clip=candidates.find(c=>c.id===clipId),source=clip&&project.assets.find(a=>a.id===clip.assetId);
  const times=useMemo(()=>analysis?beatTimes(analysis,settings):[],[analysis,settings]);
  const stale=!!(clip&&analysis&&sourceKey!==beatSourceKey(project,clip));
  const stop=useCallback(()=>{generation.current++;abort.current?.abort();worker.current?.terminate();worker.current=null;},[]);
  useEffect(()=>{const el=dialog.current!;el.showModal();return()=>{stop();el.close();};},[stop]);
  const detect=async()=>{
    if(!clip||!source)return;stop();const run=generation.current,controller=new AbortController();abort.current=controller;
    setError("");setAnalysis(null);setProgress(0);setSourceKey(beatSourceKey(project,clip));
    try{
      const samples=await decodeClipAudio(clip,source,{signal:controller.signal,maxDuration:600});
      if(run!==generation.current)return;
      const task=new Worker(new URL("./beatDetection.worker.ts",import.meta.url),{type:"module"});worker.current=task;
      task.onmessage=(event:MessageEvent<{type:string;value:number;result:BeatAnalysis;message:string}>)=>{
        if(run!==generation.current)return;
        if(event.data.type==="progress")setProgress(event.data.value);
        else {task.terminate();worker.current=null;setProgress(null);if(event.data.type==="result"){
          setAnalysis(event.data.result);if(!event.data.result.peaks.length)setError("No clear rhythmic hits were found. Try another clip, or place beats manually.");
        }else setError(event.data.message);}
      };
      task.onerror=()=>{if(run!==generation.current)return;task.terminate();worker.current=null;setProgress(null);setError("Beat analysis could not start. Please retry with an MP3 or WAV clip.");};
      task.postMessage({samples},[samples.buffer]);
    }catch(e){if(run!==generation.current)return;setProgress(null);setError((e as Error).message);}
  };
  const change=<K extends keyof BeatSettings>(name:K,value:BeatSettings[K])=>setSettings(old=>({...old,[name]:value}));
  return <dialog ref={dialog} className="beat-dialog" aria-labelledby="beat-title" onCancel={e=>{e.preventDefault();stop();close();}}>
    <div className="beat-dialog-heading"><div><AudioLines size={20}/><div><h2 id="beat-title">Find the rhythm</h2><p>Local beat analysis. Preview, refine, then mark.</p></div></div><button aria-label="Close beat detection" onClick={()=>{stop();close();}}><X size={18}/></button></div>
    <label className="field">Audio source<select aria-label="Beat detection source" value={clipId} disabled={progress!==null} onChange={e=>{stop();setClipId(e.target.value);setAnalysis(null);setError("");}}>{candidates.map(c=><option key={c.id} value={c.id}>{project.assets.find(a=>a.id===c.assetId)?.name} · {clock(c.start)} – {clock(c.start+clipDuration(c))}</option>)}</select></label>
    <p className="field-note">Uses the clip&apos;s trim and playback speed. Analysis is limited to the first 10 minutes of this edit. Nothing is uploaded.</p>
    {!candidates.length&&<p className="beat-error">Add an audio or video clip to the timeline first.</p>}
    <div className="beat-detect-row"><button className="button primary" disabled={!clip||progress!==null} onClick={()=>void detect()}><AudioLines size={16}/>{analysis?"Reanalyze audio":"Detect beats"}</button>{progress!==null&&<><progress aria-label="Beat analysis progress" max={1} value={progress}/><span role="status">{progress===0?"Decoding audio…":`${Math.round(progress*100)}%`}</span><button className="button secondary" onClick={()=>{stop();setProgress(null);}}>Cancel analysis</button></>}</div>
    {error&&<p className="beat-error" role="alert">{error}</p>}
    {analysis&&<>
      <div className="beat-stats"><div><strong>{analysis.bpm?`${analysis.bpm} BPM`:"No tempo"}</strong><span>Estimated tempo</span></div><div><strong>{times.length} markers</strong><span>Preview, not yet applied</span></div><div><strong>{analysis.confidence>.5?"Clear pulse":analysis.confidence>.2?"Check timing":"Low confidence"}</strong><span>Music-dependent estimate</span></div></div>
      <svg className="beat-overview" viewBox="0 0 600 100" role="img" aria-label={`${times.length} suggested beats over ${analysis.duration.toFixed(1)} seconds`}>
        <path d={Array.from({length:300},(_,i)=>{const lo=Math.floor(i*analysis.energy.length/300),hi=Math.max(lo+1,Math.floor((i+1)*analysis.energy.length/300));let value=0;for(let j=lo;j<hi;j++)value=Math.max(value,analysis.energy[j]||0);return `M${i*2} ${50-value*35}V${50+value*35}`;}).join(" ")} className="beat-energy"/>
        {times.slice(0,3000).map(time=><path key={time} d={`M${time/analysis.duration*600} 5V95`} className="beat-preview-line"/>)}
      </svg>
      <div className="beat-settings">
        <label className="field">Detection mode<select aria-label="Beat detection mode" value={settings.mode} onChange={e=>change("mode",e.target.value as BeatSettings["mode"])}><option value="rhythm">Rhythm beats · tempo-aware</option><option value="hits">Strong hits · transient peaks</option></select></label>
        <label className="field">Beat density<select aria-label="Beat density" value={settings.spacing} disabled={settings.mode!=="rhythm"} onChange={e=>change("spacing",Number(e.target.value))}><option value={1}>Every beat</option><option value={2}>Every other beat</option><option value={4}>Every fourth beat</option><option value={.5}>Half-beats · double density</option></select></label>
        <label className="field">Sensitivity · {settings.sensitivity}%<input aria-label="Beat sensitivity" type="range" min={0} max={100} value={settings.sensitivity} onChange={e=>change("sensitivity",Number(e.target.value))}/></label>
        <label className="field">Timing offset (ms)<input aria-label="Beat timing offset" type="number" min={-1000} max={1000} step={10} value={settings.offsetMs} onChange={e=>change("offsetMs",Number(e.target.value))}/></label>
        <label className="field">Tempo override (BPM)<input aria-label="Beat BPM override" type="number" min={30} max={300} step={.1} disabled={settings.mode!=="rhythm"} placeholder={`Auto · ${analysis.bpm||"unknown"}`} value={settings.bpm||""} onChange={e=>change("bpm",e.target.value?Math.max(30,Math.min(300,Number(e.target.value))):0)}/></label>
        <label className="beat-replace"><input type="checkbox" checked={replace} onChange={e=>setReplace(e.target.checked)}/>Replace this clip&apos;s previous auto beats</label>
      </div>
      <div className="beat-audition"><span>Check a beat on the timeline</span>{times.filter((_,i)=>i%Math.max(1,Math.ceil(times.length/8))===0).slice(0,8).map(time=><button key={time} onClick={()=>clip&&seek(clip.start+time)}>{clock((clip?.start||0)+time,true,project.fps)}</button>)}</div>
      <p className="field-note">Half/double-time interpretations are common. Adjust BPM, density or offset to match your music. Subdivisions are interpolated. Markers are absolute timeline guides; reanalyze after moving, trimming or changing source speed. Manual beats and moments are always kept.</p>
      {stale&&<p role="alert" className="beat-error">The source timing changed. Reanalyze before applying markers.</p>}
    </>}
    <div className="beat-dialog-actions"><button className="button secondary" onClick={()=>{stop();close();}}>Close</button><button className="button primary" disabled={!clip||!analysis||!times.length||stale||progress!==null} onClick={()=>{if(clip&&analysis)apply(clip.id,sourceKey,times,settings.bpm||analysis.bpm,replace);}}>Add {times.length||""} beat markers</button></div>
  </dialog>;
}
