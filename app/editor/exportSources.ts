import { ALL_FORMATS, BlobSource, CanvasSink, Input, type WrappedCanvas } from "mediabunny";
import { clamp, type Asset, type Project } from "./model";
import { clipExportRange, exportFrameCount, exportFrameTime } from "./exportTiming";
import type { MediaSources } from "./renderer";

/** Independent per-clip decoders, with bounded lookahead rather than live players. */
export class ExportSources {
  readonly sources: MediaSources = new Map();
  private inputs = new Map<string, Input>();
  private iterators = new Map<string, AsyncGenerator<WrappedCanvas | null>>();
  private ranges = new Map<string, {start:number;end:number}>();
  constructor(private project: Project, private fps:number, private signal:AbortSignal) {}
  async input(asset: Asset) {
    let input = this.inputs.get(asset.id);
    if (!input) {
      const response = await fetch(asset.url!,{signal:this.signal});
      if (!response.ok) throw new Error(`Could not read “${asset.name}” for export.`);
      const blob=await response.blob();this.signal.throwIfAborted();
      input = new Input({formats:ALL_FORMATS,source:new BlobSource(blob)});
      this.inputs.set(asset.id,input);
    }
    return input;
  }
  async prepare(duration:number) {
    const frames=exportFrameCount(duration,this.fps);
    for (const clip of this.project.clips) {
      this.signal.throwIfAborted();
      const asset=this.project.assets.find(asset=>asset.id===clip.assetId);
      if (clip.kind!=="video" || !asset?.url || this.project.hiddenTracks.includes(`layer:${clip.track}`)) continue;
      if (asset.kind==="image") {
        const image=new Image();image.src=asset.url;await image.decode();this.signal.throwIfAborted();this.sources.set(clip.id,image);continue;
      }
      if (asset.kind!=="video") continue;
      const input=await this.input(asset),track=await input.getPrimaryVideoTrack();
      if (!track || !await track.canDecode()) throw new Error(`“${asset.name}” cannot be decoded frame by frame. Convert it to H.264 MP4 or WebM and reimport it.`);
      const range=clipExportRange(this.project,clip);this.ranges.set(clip.id,range);
      const fps=this.fps,first=await track.getFirstTimestamp();
      function* timestamps() {
        for (let index=0;index<frames;index++) {
          const time=exportFrameTime(index,fps);
          if (time>=range.start && time<range.end)
            yield Math.max(first,clamp(clip.frozenAt ?? clip.sourceStart+(time-clip.start)*clip.speed,0,Math.max(0,asset!.duration-0.000001)));
        }
      }
      this.iterators.set(clip.id,new CanvasSink(track,{poolSize:2,alpha:true}).canvasesAtTimestamps(timestamps()));
    }
  }
  async frame(time:number) {
    for (const [id,iterator] of this.iterators) {
      const range=this.ranges.get(id)!;
      if (time<range.start || time>=range.end) continue;
      this.signal.throwIfAborted();
      const decoded=await iterator.next();
      if (!decoded.value) throw new Error("A source video frame could not be decoded. Export stopped instead of saving a repeated or missing frame.");
      this.sources.set(id,decoded.value.canvas);
    }
  }
  dispose() {
    for (const input of this.inputs.values()) input.dispose();
    this.inputs.clear();this.iterators.clear();this.sources.clear();
  }
}
