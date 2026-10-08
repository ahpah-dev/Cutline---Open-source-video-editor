import { ALL_FORMATS, BlobSource, EncodedPacketSink, Input, CanvasSink } from "mediabunny";
import { exportFormats, exportProject } from "../app/editor/media";
import { makeClip, makeText, newProject } from "../app/editor/model";
import { ExportAudio } from "../app/editor/exportAudio";
import { ExportSources } from "../app/editor/exportSources";
type Check=(name:string,run:()=>unknown)=>Promise<void>;
type Assert=(value:unknown,message:string)=>void;
const tone=(pulsed=false)=>{
  const rate=48000,count=rate*3,bytes=new ArrayBuffer(44+count*2),view=new DataView(bytes);
  const text=(at:number,value:string)=>[...value].forEach((ch,i)=>view.setUint8(at+i,ch.charCodeAt(0)));
  text(0,"RIFF");view.setUint32(4,bytes.byteLength-8,true);text(8,"WAVEfmt ");view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);
  view.setUint32(24,rate,true);view.setUint32(28,rate*2,true);view.setUint16(32,2,true);view.setUint16(34,16,true);text(36,"data");view.setUint32(40,count*2,true);
  for(let i=0;i<count;i++)view.setInt16(44+i*2,Math.sin(i/rate*2*Math.PI*440)*14000*(pulsed?Math.exp(-(i/rate%.25)*150):1),true);
  return new Blob([bytes],{type:"audio/wav"});
};
async function packets(blob:Blob) {
  const input=new Input({formats:ALL_FORMATS,source:new BlobSource(blob)});
  try {const track=await input.getPrimaryVideoTrack();if(!track)throw new Error("No video track");const result=[];
    for await(const p of new EncodedPacketSink(track).packets()) result.push({timestamp:p.timestamp,duration:p.duration});
    return result.sort((a,b)=>a.timestamp-b.timestamp);
  } finally {input.dispose();}
}
export async function runOfflineExportChecks(check:Check,assert:Assert) {
  await check("Disk-target MP4/VP9/VP8 exports honor seek-back writes, bounded chunks and slow-writer backpressure",async()=>{
    const p={...newProject(),texts:[makeText(0,{text:"DISK TEST",duration:.6,comboAnimations:[{name:"Pulse",speed:1,amount:60}]})]};
    for(const format of exportFormats()) {
      const chunks:{data:Uint8Array<ArrayBuffer>;position:number}[]=[];let inFlight=0,maxInFlight=0;
      const size=await exportProject(p,{resolution:144,fps:60,mime:format.mime,signal:new AbortController().signal,onProgress(){},sink:{async write(data,position){
        inFlight++;maxInFlight=Math.max(maxInFlight,inFlight);
        assert(data.byteLength<=1024*1024,'Unbounded output chunk');
        await new Promise(resolve=>setTimeout(resolve,12));chunks.push({data:data.slice(),position});inFlight--;
      }}});
      assert(size>0&&chunks.length>0&&maxInFlight===1,'Missing writes or overlapping unbounded writer');
      const buffer=new Uint8Array(size);for(const chunk of chunks)buffer.set(chunk.data,chunk.position);
      const list=await packets(new Blob([buffer],{type:format.mime}));
      assert(list.length===36&&Math.abs(list.at(-1)!.timestamp+list.at(-1)!.duration-.6)<.002,'Streamed file is corrupt or lost frames');
    }
    const controller=new AbortController();let failed=false;
    try { await exportProject(p,{resolution:144,fps:30,mime:exportFormats()[0].mime,signal:controller.signal,onProgress(){},sink:{async write(){throw new Error('Simulated disk full');}}}); }
    catch(error){failed=(error as Error).message.includes('Simulated disk full');}
    assert(failed,'Writer failure was swallowed');
  });
  await check("Offline MP4/VP9/VP8 exports preserve every 30/60 fps frame, exact duration and cadence despite deliberate stalls",async()=>{
    const p={...newProject(),texts:[makeText(0,{text:"FRAME TEST",duration:.6,comboAnimations:[{name:"Pulse",speed:1,amount:60}]})]};
    for(const format of exportFormats())for(const fps of [30,60]){
      const blob=await exportProject(p,{resolution:144,fps,mime:format.mime,signal:new AbortController().signal,onProgress(progress,phase){
        if(phase.startsWith("Rendering")&&progress>.25&&progress<.4){const end=performance.now()+65;while(performance.now()<end){/* artificial CPU load */}}
      }}),list=await packets(blob);
      assert(list.length===Math.round(.6*fps),`${format.label}/${fps}: ${list.length} frames, dropped frames`);
      for(let i=0;i<list.length;i++)assert(Math.abs(list[i].timestamp-i/fps)<.0011,`Irregular timestamp ${format.label}/${fps}/${i}: ${list[i].timestamp}`);
      assert(Math.abs(list.at(-1)!.timestamp+list.at(-1)!.duration-.6)<.002,"Export tail or duration drifted");
    }
  });
  await check("Sub-second static edits encode their full frame count instead of failing or growing a recording tail",async()=>{
    const p={...newProject(),texts:[makeText(0,{text:"Short",duration:.1})]};
    const blob=await exportProject(p,{resolution:144,fps:30,mime:exportFormats()[0].mime,signal:new AbortController().signal,onProgress(){}}),list=await packets(blob);
    assert(list.length===3&&Math.abs(list.at(-1)!.timestamp+list.at(-1)!.duration-.1)<.002,"Short silent export has wrong cadence/tail");
  });
  await check("Offline source decoding retains successive real video frames through trim, speed and duplicate source instances",async()=>{
    const p={...newProject(),texts:[makeText(0,{text:"MOVING",duration:1,animation:"Drift",animationDuration:1,animationSettings:{distance:.5}})]};
    const format=exportFormats()[0],blob=await exportProject(p,{resolution:144,fps:30,mime:format.mime,signal:new AbortController().signal,onProgress(){}});
    const input=new Input({formats:ALL_FORMATS,source:new BlobSource(blob)}),url=URL.createObjectURL(blob);
    const asset={id:"offline-source",name:"Motion.mp4",kind:"video" as const,duration:1,url,width:256,height:144,sizeLabel:"1 KB",theme:"video"};
    const project={...newProject(),assets:[asset],clips:[{...makeClip(asset),sourceStart:.2,sourceEnd:.8,speed:2},{...makeClip(asset,0,1),sourceStart:.3,sourceEnd:.9,speed:2}]};
    const sources=new ExportSources(project,30,new AbortController().signal);
    try {
      const track=await input.getPrimaryVideoTrack(),sink=new CanvasSink(track!,{poolSize:1});await sources.prepare(.3);
      const hash=(canvas:HTMLCanvasElement|OffscreenCanvas)=>{
        const data=canvas.getContext("2d")!.getImageData(0,0,256,144).data;let value=0;for(let i=0;i<data.length;i+=4)value=(Math.imul(value,31)+data[i]+data[i+1]+data[i+2])|0;return value;
      };
      const signatures=new Set<number>();
      for(let i=0;i<9;i++){
        await sources.frame(i/30);
        for(const clip of project.clips){const actual=sources.sources.get(clip.id) as HTMLCanvasElement,expected=await sink.getCanvas(clip.sourceStart+i/30*2);
          assert(expected&&hash(actual)===hash(expected.canvas),"Incorrect original source frame at trim/speed");signatures.add(hash(actual));}
      }
      assert(signatures.size>5,"Video frames were repeated instead of decoded");
    } finally {sources.dispose();input.dispose();URL.revokeObjectURL(url);}
  });
  await check("Offline audio has exact samples, timed silence/fades/pan and pitch-preserving speed without discontinuities between chunks",async()=>{
    const url=URL.createObjectURL(tone()),asset={id:"offline-tone",name:"Tone.wav",kind:"audio" as const,duration:3,url,sizeLabel:"1 KB",theme:"audio"};
    const clip={...makeClip(asset,.1),sourceEnd:2,speed:2,fadeIn:.02,fadeOut:.03,audioPan:-1};
    const p={...newProject(),assets:[asset],clips:[clip]},sources=new ExportSources(p,30,new AbortController().signal),audio=new ExportAudio(p,sources,new AbortController().signal);
    try {
      assert(await audio.prepare(),"Audio track not prepared");
      const first=await audio.chunk(0,24000),second=await audio.chunk(24000,28800),joined=new Float32Array(52800);
      joined.set(first.getChannelData(0));joined.set(second.getChannelData(0),24000);
      assert(joined.slice(0,4500).every(v=>Math.abs(v)<.0001),"Audio started before clip");
      let crossings=0;for(let i=9601;i<19200;i++)if(joined[i-1]<=0&&joined[i]>0)crossings++;
      assert(Math.abs(crossings/.2-440)<20,`Speed changed source pitch: ${crossings/.2} Hz`);
      assert(Math.abs(joined[24000]-joined[23999])<.1,"Chunk boundary clicks/discontinuity");
      assert(second.getChannelData(1).every(v=>Math.abs(v)<.0001),"Hard left pan leaked right audio");
      assert(joined.slice(52800-32).every(v=>Math.abs(v)<.01)&&Math.abs(joined.at(-1)!)<.001,"Fade out/timeline endpoint missing");
      const result=await exportProject(p,{resolution:144,fps:60,mime:exportFormats()[0].mime,signal:new AbortController().signal,onProgress(){}});
      const encoded=await packets(result);assert(encoded.length===66,"Audio-only video duration/frame count drifted");
    } finally {sources.dispose();URL.revokeObjectURL(url);}
  });
  await check("Decoded MP4/VP9/VP8 audio beats stay aligned with exact video timestamps despite slow rendering",async()=>{
    const url=URL.createObjectURL(tone(true)),asset={id:"sync-beats",name:"Sync.wav",kind:"audio" as const,duration:3,url,sizeLabel:"1 KB",theme:"audio"};
    const p={...newProject(),assets:[asset],clips:[makeClip(asset,.2)],texts:[makeText(0,{text:"SYNC",duration:3.2})]};
    const context=new AudioContext();
    try {
      for(const format of exportFormats()) {
        const blob=await exportProject(p,{resolution:144,fps:60,mime:format.mime,signal:new AbortController().signal,onProgress(value,phase){
          if(phase.startsWith("Rendering")&&value>.48&&value<.51){const end=performance.now()+35;while(performance.now()<end){/* simulate rendering stalls */}}
        }}),frames=await packets(blob);
        assert(frames.length===192,"Video clock lost frames during audio mixing");
        const buffer=await context.decodeAudioData(await blob.arrayBuffer()),data=buffer.getChannelData(0),rate=buffer.sampleRate;
        for(let beat=0;beat<12;beat++) {
          const expected=.2+beat*.25,begin=Math.round((expected-.02)*rate),end=Math.round((expected+.02)*rate);
          let peak=0,position=begin;
          for(let i=begin;i<end;i++)if(Math.abs(data[i])>peak){peak=Math.abs(data[i]);position=i;}
          assert(peak>.02&&Math.abs(position/rate-expected)<.008,`${format.label}: beat ${beat} drifted ${position/rate-expected}s`);
        }
      }
    } finally {await context.close();URL.revokeObjectURL(url);}
  });
}
