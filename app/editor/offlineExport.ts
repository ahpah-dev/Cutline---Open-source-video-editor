import { AudioBufferSource, BufferTarget, CanvasSource, Mp4OutputFormat, Output, Quality, WebMOutputFormat, canEncodeAudio, canEncodeVideo } from "mediabunny";
import { dimensions, projectDuration, type Project } from "./model";
import { Renderer } from "./renderer";
import { ensureTextFonts } from "./textFonts";
import { ExportSources } from "./exportSources";
import { EXPORT_AUDIO_RATE, ExportAudio } from "./exportAudio";
import { exportFrameCount, exportFrameTime } from "./exportTiming";

export type ExportOptions={resolution:number;fps:number;mime:string;signal:AbortSignal;onProgress:(progress:number,phase:string)=>void};

export async function renderOffline(project:Project,options:ExportOptions) {
  const {signal,onProgress}=options,check=()=>signal.throwIfAborted();check();
  const duration=projectDuration(project),{width,height}=dimensions(project.ratio,options.resolution);
  const mp4=options.mime.startsWith("video/mp4"),codec=mp4 ? "avc" : options.mime.includes("vp9") ? "vp9" : "vp8";
  const audioCodec=mp4 ? "aac" : "opus";
  const quality=new Quality({bitrate:(options.resolution>=2160?24000000:options.resolution>=1080?10000000:5000000)*Math.max(1,options.fps/30)});
  if (!await canEncodeVideo(codec,{width,height,frameRate:options.fps,quality,latencyMode:"quality"}))
    throw new Error("This codec/resolution/frame rate cannot be encoded on this device. Try H.264 MP4 at 1080p/30 fps or WebM. No low-quality real-time fallback was used.");
  check();
  const canvas=document.createElement("canvas");canvas.width=width;canvas.height=height;
  const renderer=new Renderer(),sources=new ExportSources(project,options.fps,signal),audio=new ExportAudio(project,sources,signal);
  const output=new Output({format:mp4?new Mp4OutputFormat({fastStart:"in-memory"}):new WebMOutputFormat(),target:new BufferTarget()});
  let finished=false;
  let rejectAbort:(error:DOMException)=>void=()=>{};
  const aborted=new Promise<never>((_,reject)=>{rejectAbort=reject;});
  // A canceled image/font/decoder task may still settle later, but cannot keep
  // the export dialog blocked or leave an unhandled promise rejection behind.
  void aborted.catch(()=>{});
  const wait=<T>(promise:Promise<T>)=>Promise.race([promise,aborted]);
  const cancel=()=>{rejectAbort(new DOMException("Export cancelled","AbortError"));sources.dispose();void output.cancel().catch(()=>{});};
  signal.addEventListener("abort",cancel,{once:true});
  try {
    onProgress(0,"Preparing frame-accurate export");
    check();await wait(ensureTextFonts(project));check();
    await wait(sources.prepare(duration));check();
    const hasAudio=await wait(audio.prepare());check();
    if (hasAudio && !await wait(canEncodeAudio(audioCodec,{sampleRate:EXPORT_AUDIO_RATE,numberOfChannels:2})))
      throw new Error("This device cannot encode the selected audio codec. Choose WebM to keep your audio; export will not silently drop it.");
    const encodedFrames=new Set<number>();let encodedCount=0,badTiming=false;
    const videoSource=new CanvasSource(canvas,{codec,quality,latencyMode:"quality",keyFrameInterval:2,
      onEncodedPacket(packet) {
        const index=Math.round(packet.timestamp*options.fps);
        encodedCount++;encodedFrames.add(index);
        if (Math.abs(packet.timestamp-index/options.fps)>0.000002) badTiming=true;
      }});
    output.addVideoTrack(videoSource,{frameRate:options.fps});
    const audioSource=hasAudio?new AudioBufferSource({codec:audioCodec,quality:new Quality({bitrate:192000})}):null;
    if (audioSource) output.addAudioTrack(audioSource);
    await wait(output.start());check();
    const count=exportFrameCount(duration,options.fps),samples=Math.round(duration*EXPORT_AUDIO_RATE);
    let audioAt=0;
    for (let index=0;index<count;index++) {
      check();const time=exportFrameTime(index,options.fps);
      if (audioSource && time>=audioAt/EXPORT_AUDIO_RATE && audioAt<samples) {
        const size=Math.min(EXPORT_AUDIO_RATE,samples-audioAt);
        await wait(audioSource.add(await wait(audio.chunk(audioAt,size))));audioAt+=size;check();
      }
      await wait(sources.frame(time));check();
      renderer.draw(canvas,project,time,sources.sources);
      await wait(videoSource.add(time,1/options.fps));check();
      onProgress((index+1)/count,"Rendering every frame — no frames skipped");
      // Yield to Cancel and the UI; encoded timestamps are independent of waits.
      if (index%8===7) await new Promise(resolve=>setTimeout(resolve,0));
    }
    while (audioSource && audioAt<samples) {check();const size=Math.min(EXPORT_AUDIO_RATE,samples-audioAt);await wait(audioSource.add(await wait(audio.chunk(audioAt,size))));audioAt+=size;}
    videoSource.close();audioSource?.close();check();onProgress(1,"Finishing constant-frame-rate video");
    await wait(output.finalize());check();finished=true;
    if (badTiming || encodedCount!==count || encodedFrames.size!==count || !encodedFrames.has(0) || !encodedFrames.has(count-1))
      throw new Error("The encoder did not preserve every frame at the requested frame rate. Export was rejected; try another format or a lower resolution.");
    const buffer=output.target.buffer;
    if (!buffer?.byteLength) throw new Error("The encoder produced an empty video. Try another format.");
    onProgress(1,"Video ready");return new Blob([buffer],{type:output.format.mimeType});
  } catch(error) {
    if (signal.aborted) throw new DOMException("Export cancelled","AbortError");
    throw error;
  } finally {
    signal.removeEventListener("abort",cancel);sources.dispose();renderer.dispose();
    if (!finished) await output.cancel().catch(()=>{});
  }
}
