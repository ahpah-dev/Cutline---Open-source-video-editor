import { AudioBufferSink, type WrappedAudioBuffer } from "mediabunny";
import { clamp, type Clip, type Project } from "./model";
import { clipExportRange, exportAudioControl, panStereo } from "./exportTiming";
import { ExportSources } from "./exportSources";

export const EXPORT_AUDIO_RATE=48000;
type Segment={timestamp:number;duration:number;rate:number;channels:Float32Array[]};
type Grain={index:number;left:Float32Array;right:Float32Array};
type AudioPlan={clip:Clip;sink:AudioBufferSink;mono:boolean;range:{start:number;end:number};grains:Map<number,Grain>};

function segment(buffer:WrappedAudioBuffer):Segment {
  return {timestamp:buffer.timestamp,duration:buffer.duration,rate:buffer.buffer.sampleRate,
    channels:Array.from({length:buffer.buffer.numberOfChannels},(_,i)=>buffer.buffer.getChannelData(i))};
}
function reader(segments:Segment[],channel:number) {
  let cursor=0;
  return (time:number) => {
    while (cursor>0 && time<segments[cursor].timestamp) cursor--;
    while (cursor<segments.length-1 && time>=segments[cursor].timestamp+segments[cursor].duration) cursor++;
    const part=segments[cursor];
    if (!part || time<part.timestamp || time>=part.timestamp+part.duration) return 0;
    const data=part.channels[Math.min(channel,part.channels.length-1)],position=(time-part.timestamp)*part.rate;
    const at=Math.floor(position),fraction=position-at;
    const value=(data[at] ?? 0)*(1-fraction)+(data[Math.min(at+1,data.length-1)] ?? 0)*fraction;
    return Number.isFinite(value) ? value : 0;
  };
}

/** Audio is decoded/mixed in one-second windows, never clocked by live playback. */
export class ExportAudio {
  private plans:AudioPlan[]=[];
  constructor(private project:Project,private sources:ExportSources,private signal:AbortSignal) {}
  async prepare() {
    for (const clip of this.project.clips) {
      this.signal.throwIfAborted();
      const asset=this.project.assets.find(a=>a.id===clip.assetId);
      if (!asset?.url || !["video","audio"].includes(asset.kind)) continue;
      const input=await this.sources.input(asset),track=await input.getPrimaryAudioTrack();
      if (!track) {
        if (asset.kind==="audio") throw new Error(`No readable audio track in “${asset.name}”.`);
        continue;
      }
      if (!await track.canDecode()) throw new Error(`The audio in “${asset.name}” cannot be decoded for export. Reimport a WAV, MP3 or AAC version.`);
      this.plans.push({clip,sink:new AudioBufferSink(track),mono:await track.getNumberOfChannels()===1,
        range:clipExportRange(this.project,clip),grains:new Map()});
    }
    return this.plans.length>0;
  }
  async chunk(startSample:number,length:number) {
    const rate=EXPORT_AUDIO_RATE,start=startSample/rate,end=(startSample+length)/rate;
    const output=new AudioBuffer({sampleRate:rate,numberOfChannels:2,length});
    const left=output.getChannelData(0),right=output.getChannelData(1);
    for (const plan of this.plans) {
      this.signal.throwIfAborted();
      const {clip,range}=plan;
      if (clip.frozenAt!==undefined || range.start>=end || range.end<=start ||
          this.project.mutedTracks.includes(`layer:${clip.track}`) || this.project.hiddenTracks.includes(`layer:${clip.track}`)) continue;
      const sourceBegin=Math.max(0,clip.sourceStart+(Math.max(start,range.start)-clip.start)*clip.speed-.16);
      const sourceEnd=Math.max(0,clip.sourceStart+(Math.min(end,range.end)-clip.start)*clip.speed+.16);
      const segments:Segment[]=[];
      for await (const buffer of plan.sink.buffers(sourceBegin,sourceEnd)) { this.signal.throwIfAborted();segments.push(segment(buffer)); }
      if (!segments.length) continue;
      const readLeft=reader(segments,0),readRight=reader(segments,1);
      let clipLeft:Float32Array,clipRight:Float32Array;
      if (Math.abs(clip.speed-1)<1e-8) {
        clipLeft=new Float32Array(length);clipRight=new Float32Array(length);
        for (let i=0;i<length;i++) {
          const time=(startSample+i)/rate,sourceTime=clip.sourceStart+time-clip.start;
          clipLeft[i]=readLeft(sourceTime);clipRight[i]=readRight(sourceTime);
        }
      } else {
        [clipLeft,clipRight]=this.stretch(plan,startSample,length,readLeft,readRight);
      }
      // Smooth audio automation at bounded sub-frame intervals. Sample count and
      // timestamps stay exact even when decoding, effects or encoding are slow.
      const step=128;
      let control=exportAudioControl(this.project,clip,start);
      for (let offset=0;offset<length;offset+=step) {
        const count=Math.min(step,length-offset),next=exportAudioControl(this.project,clip,(startSample+offset+count)/rate);
        for (let j=0;j<count;j++) {
          const time=(startSample+offset+j)/rate;
          if (time<range.start || time>=range.end) continue;
          const t=j/count,gain=control.gain+(next.gain-control.gain)*t,pan=control.pan+(next.pan-control.pan)*t;
          const [l,r]=panStereo(clipLeft[offset+j],clipRight[offset+j],pan,plan.mono);
          left[offset+j]+=l*gain;right[offset+j]+=r*gain;
        }
        control=next;
      }
    }
    for (let i=0;i<length;i++) {left[i]=clamp(left[i],-1,1);right[i]=clamp(right[i],-1,1);}
    return output;
  }
  /** Waveform-similarity overlap/add keeps tempo changes from shifting pitch.
   * Grains cross chunk boundaries and source phase search remains bounded. */
  private stretch(plan:AudioPlan,startSample:number,length:number,readLeft:(time:number)=>number,readRight:(time:number)=>number):[Float32Array,Float32Array] {
    const rate=EXPORT_AUDIO_RATE,hop=960,size=hop*2,anchor=Math.round(plan.range.start*rate);
    const first=Math.max(0,Math.floor((startSample-anchor)/hop)-1),last=Math.floor((startSample+length-1-anchor)/hop);
    const left=new Float32Array(length),right=new Float32Array(length),weights=new Float32Array(length);
    for (let n=first;n<=last;n++) {
      let grain=plan.grains.get(n);
      if (!grain) {
        this.signal.throwIfAborted();
        const expected=plan.clip.sourceStart+((anchor+n*hop)/rate-plan.clip.start)*plan.clip.speed;
        let shift=0,best=-Infinity;
        const previous=plan.grains.get(n-1);
        if (previous) {
          for (let candidate=-384;candidate<=384;candidate+=16) {
            let dot=0,energy=1e-12;
            for (let i=0;i<hop;i+=16) {
              const at=expected+(candidate+i)/rate,l=readLeft(at),r=readRight(at);
              dot+=l*previous.left[hop+i]+r*previous.right[hop+i];energy+=l*l+r*r;
            }
            const score=dot/Math.sqrt(energy);
            if (score>best+1e-10 || (Math.abs(score-best)<=1e-10&&Math.abs(candidate)<Math.abs(shift))) {best=score;shift=candidate;}
          }
        }
        grain={index:n,left:new Float32Array(size),right:new Float32Array(size)};
        for (let i=0;i<size;i++) { const at=expected+(shift+i)/rate;grain.left[i]=readLeft(at);grain.right[i]=readRight(at); }
        plan.grains.set(n,grain);
      }
      const offset=anchor+n*hop-startSample;
      for (let i=Math.max(0,-offset);i<Math.min(size,length-offset);i++) {
        const weight=Math.sin(Math.PI*(i+.5)/size)**2,at=offset+i;
        left[at]+=grain.left[i]*weight;right[at]+=grain.right[i]*weight;weights[at]+=weight;
      }
    }
    for (let i=0;i<length;i++) if (weights[i]>1e-12) {left[i]/=weights[i];right[i]/=weights[i];}
    for (const n of plan.grains.keys()) if (n<last-1) plan.grains.delete(n);
    return [left,right];
  }
}
