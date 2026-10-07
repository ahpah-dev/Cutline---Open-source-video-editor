import { clamp, clipDuration, roundFrame, uid, type Project, type TimelineMarker } from "./model";

export type BeatAnalysis = {
  duration: number; hopSeconds: number; bpm: number; confidence: number;
  envelope: Float32Array; energy: Float32Array;
  peaks: {time:number; strength:number}[];
};
export type BeatSettings = {mode:"rhythm"|"hits"; sensitivity:number; bpm:number; spacing:number; offsetMs:number};
export const DEFAULT_BEAT_SETTINGS: BeatSettings = {mode:"rhythm",sensitivity:60,bpm:0,spacing:1,offsetMs:0};

/** Local spectral-flux onset analysis. Tempo is estimated from autocorrelation;
 * a tempo-constrained dynamic-programming path follows the actual onsets rather
 * than treating loud waveform peaks as beats. No model or network is needed.
 */
export function analyzeBeats(samples: Float32Array, sampleRate=16000, progress:(value:number)=>void=()=>{}): BeatAnalysis {
  if (!Number.isFinite(sampleRate)||sampleRate<=0||samples.length<sampleRate*.25) throw new Error("Choose at least a quarter-second of audio.");
  const n=1024,hop=256,frames=Math.ceil(samples.length/hop),envelope=new Float32Array(frames),energy=new Float32Array(frames);
  const real=new Float32Array(n),imag=new Float32Array(n),previous=new Float32Array(n/2),window=new Float32Array(n),reverse=new Uint16Array(n);
  for(let i=0;i<n;i++){window[i]=.5-.5*Math.cos(2*Math.PI*i/(n-1));let value=i,bits=0;for(let j=0;j<10;j++){bits=(bits<<1)|(value&1);value>>=1;}reverse[i]=bits;}
  let maxEnergy=0;
  for(let frame=0;frame<frames;frame++){
    let sum=0;
    // Centered windows keep onset timestamps in source time; no arbitrary
    // half-window latency is added to the resulting timeline markers.
    for(let i=0;i<n;i++){const value=samples[frame*hop+i-n/2]??0;real[reverse[i]]=value*window[i];imag[i]=0;sum+=value*value;}
    energy[frame]=Math.sqrt(sum/n);maxEnergy=Math.max(maxEnergy,energy[frame]);
    for(let length=2;length<=n;length*=2){const half=length/2,angle=-2*Math.PI/length,wr=Math.cos(angle),wi=Math.sin(angle);
      for(let start=0;start<n;start+=length){let cr=1,ci=0;for(let j=0;j<half;j++){const a=start+j,b=a+half,tr=real[b]*cr-imag[b]*ci,ti=real[b]*ci+imag[b]*cr;real[b]=real[a]-tr;imag[b]=imag[a]-ti;real[a]+=tr;imag[a]+=ti;const next=cr*wr-ci*wi;ci=cr*wi+ci*wr;cr=next;}}
    }
    let flux=0;
    for(let bin=2;bin<n/2;bin++){const hz=bin*sampleRate/n,magnitude=Math.log1p(Math.hypot(real[bin],imag[bin])*20);const delta=Math.max(0,magnitude-previous[bin]);
      flux+=delta*(hz<250?2.4:hz<2000?1: .4);previous[bin]=magnitude;
    }
    envelope[frame]=flux;
    if(frame%128===0)progress(frame/frames*.85);
  }
  if(maxEnergy<.0001) return {duration:samples.length/sampleRate,hopSeconds:hop/sampleRate,bpm:0,confidence:0,envelope,energy,peaks:[]};
  const raw=envelope.slice();let maxFlux=0;
  // Subtract a local average floor to suppress sustained tones and slow swells.
  const radius=Math.round(sampleRate/hop*.25),prefix=new Float64Array(frames+1);
  for(let i=0;i<frames;i++)prefix[i+1]=prefix[i]+raw[i];
  for(let i=0;i<frames;i++){const lo=Math.max(0,i-radius),hi=Math.min(frames,i+radius+1);envelope[i]=Math.max(0,raw[i]-(prefix[hi]-prefix[lo])/(hi-lo)*.8);maxFlux=Math.max(maxFlux,envelope[i]);energy[i]/=maxEnergy;}
  if(maxFlux<1e-6) return {duration:samples.length/sampleRate,hopSeconds:hop/sampleRate,bpm:0,confidence:0,envelope,energy,peaks:[]};
  for(let i=0;i<frames;i++)envelope[i]/=maxFlux;
  const peaks:BeatAnalysis["peaks"]=[];
  for(let i=1;i<frames-1;i++)if(envelope[i]>.025&&energy[i]>.01&&envelope[i]>=envelope[i-1]&&envelope[i]>envelope[i+1]){
    const peak={time:i*hop/sampleRate,strength:envelope[i]},last=peaks.at(-1);
    if(last&&peak.time-last.time<.075){if(peak.strength>last.strength)peaks[peaks.length-1]=peak;}else peaks.push(peak);
  }
  let bestScore=0,bestLag=0;const fps=sampleRate/hop,minLag=Math.round(fps*60/220),maxLag=Math.min(frames-1,Math.round(fps*60/45));
  for(let lag=minLag;lag<=maxLag;lag++){
    let score=0,total=0;for(let i=lag;i<frames;i++){score+=envelope[i]*envelope[i-lag];total+=envelope[i]*envelope[i];}
    // A broad musical-tempo prior reduces double/half-time ambiguity. The UI
    // exposes half/double density and a BPM override because neither is certain.
    score=score/Math.max(1e-9,total)*Math.exp(-.5*(Math.log2((60*fps/lag)/120)/1.5)**2);
    if(score>bestScore){bestScore=score;bestLag=lag;}
  }
  progress(1);
  let bpm=bestLag?60*fps/bestLag:0;
  const strong=peaks.filter(p=>p.strength>.2),intervals=strong.slice(1).map((p,i)=>p.time-strong[i].time).filter(d=>d>.25&&d<1.4).sort((a,b)=>a-b);
  if(intervals.length>=4){const median=intervals[Math.floor(intervals.length/2)],onsetBpm=60/median,ratio=onsetBpm/bpm;
    const consistent=intervals.filter(d=>Math.abs(d-median)<median*.12).length/intervals.length>.7;
    // Correct the common octave error when strong, regularly spaced onsets
    // consistently support the faster pulse; don't infer an octave from noise.
    if(consistent&&onsetBpm>=45&&onsetBpm<=220&&(Math.abs(ratio-1)<.12||Math.abs(ratio-2)<.2))bpm=onsetBpm;
  }
  return {duration:samples.length/sampleRate,hopSeconds:hop/sampleRate,bpm:Math.round(bpm*10)/10,confidence:clamp(bestScore,0,1),envelope,energy,peaks};
}

export function beatTimes(analysis:BeatAnalysis,settings:BeatSettings):number[]{
  const sensitivity=clamp(settings.sensitivity,0,100),threshold=.4-.0035*sensitivity;
  let times:number[]=[];
  if(settings.mode==="hits") times=analysis.peaks.filter(p=>p.strength>=threshold).map(p=>p.time);
  else{
    const bpm=settings.bpm||analysis.bpm;if(!Number.isFinite(bpm)||bpm<30||bpm>300||!analysis.peaks.length)return [];
    const period=60/bpm/analysis.hopSeconds,env=analysis.envelope,length=env.length;
    const scores=new Float32Array(length),previous=new Int32Array(length);previous.fill(-1);
    let best=0;
    for(let i=0;i<length;i++){
      const local=env[i] >= threshold*.4 && analysis.energy[i]>.025?env[i]:0;
      let score=0,prev=-1;
      for(let gap=Math.max(1,Math.floor(period*.7));gap<=Math.ceil(period*1.3)&&gap<=i;gap++){
        const candidate=scores[i-gap]-2*(Math.log(gap/period))**2;
        if(candidate>score){score=candidate;prev=i-gap;}
      }
      scores[i]=local+score*.96;previous[i]=prev;
      if(scores[i]>scores[best])best=i;
    }
    const indices:number[]=[];
    const lastPeak=Math.min(length-1,Math.round(analysis.peaks.at(-1)!.time/analysis.hopSeconds));
    let tailBest=-1;
    for(let i=Math.max(0,lastPeak-Math.ceil(period*2));i<=lastPeak;i++)if(env[i]>threshold*.18&&(tailBest<0||scores[i]>scores[tailBest]))tailBest=i;
    if(tailBest>=0)best=tailBest;
    for(let at=best;at>=0;at=previous[at]){indices.push(at);if(previous[at]<0)break;}
    indices.reverse();
    // Re-anchor each beat to a nearby transient. Do not create guides in
    // silence merely because the tempo clock continued to tick.
    times=indices.flatMap(i=>{let at=i;const radius=Math.max(1,Math.round(period*.12));
      for(let j=Math.max(0,i-radius);j<Math.min(length,i+radius+1);j++)if(env[j]>env[at])at=j;
      return analysis.energy[at]>.025&&env[at]>threshold*.18?[at*analysis.hopSeconds]:[];
    });
    if(settings.spacing>=2)times=times.filter((_,i)=>i%settings.spacing===0);
    else if(settings.spacing===.5){const doubled:number[]=[];for(let i=0;i<times.length;i++){doubled.push(times[i]);if(i<times.length-1&&times[i+1]-times[i]<1.5*60/bpm)doubled.push((times[i]+times[i+1])/2);}times=doubled;}
  }
  const offset=clamp(settings.offsetMs,-1000,1000)/1000;
  return [...new Set(times.map(time=>Math.round((time+offset)*10000)/10000).filter(time=>time>=0&&time<analysis.duration))].sort((a,b)=>a-b);
}

/** Preserve hand-placed guides and other clips' auto markers; a rerun replaces
 * only this source's detected guides, and the caller commits one undo step. */
export function applyBeatMarkers(project:Project,clipId:string,times:number[],bpm:number,replace=true):Project{
  const clip=project.clips.find(c=>c.id===clipId);if(!clip)return project;
  const markers=project.markers.filter(m=>!(replace&&m.source==="auto"&&m.sourceClipId===clipId));
  const frames=new Set(markers.filter(m=>m.kind==="beat").map(m=>roundFrame(m.time,project.fps)));
  for(const time of times){if(!Number.isFinite(time)||time<0||time>=clipDuration(clip))continue;const at=roundFrame(clip.start+time,project.fps);if(frames.has(at))continue;frames.add(at);
    markers.push({id:uid("beat"),kind:"beat",time:at,source:"auto",sourceClipId:clipId,...(bpm>0?{bpm}: {})} as TimelineMarker);
  }
  return {...project,markers:markers.sort((a,b)=>a.time-b.time)};
}
