import { clamp, clipDuration, makeText, type Asset, type Clip, type TextClip } from "./model";
import { loadMediaAsset } from "../editorStorage";

export type WhisperChunk = { text: string; timestamp: [number, number | null] };

/** Decode the imported local media and resample exactly the selected edit to Whisper's 16 kHz mono input. */
export async function decodeClipAudio(clip: Clip, asset: Asset, options:{signal?:AbortSignal;maxDuration?:number} = {}): Promise<Float32Array> {
  const check=()=>{if(options.signal?.aborted)throw new DOMException("Audio analysis cancelled", "AbortError");};
  check();
  const savedMedia = await loadMediaAsset(asset.id);
  let source: ArrayBuffer;
  if (savedMedia?.blob) {
    source = await savedMedia.blob.arrayBuffer();
  } else {
    if (!asset.url) throw new Error("The source file is missing. Relink or re-import this media.");
    try {
      const response = await fetch(asset.url,{signal:options.signal});
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      source = await response.arrayBuffer();
    } catch {
      check();throw new Error("Could not read this clip's source file. Relink or re-import the media, then try again.");
    }
  }
  const context = new AudioContext();
  try {
    check();
    const decoded = await context.decodeAudioData(source);
    check();
    const duration = Math.min(clipDuration(clip), options.maxDuration ?? 60 * 60);
    const output = new Float32Array(Math.ceil(duration * 16000));
    const channels = Array.from({ length: decoded.numberOfChannels }, (_, index) => decoded.getChannelData(index));
    const sourceStart = clip.sourceStart * decoded.sampleRate;
    const stride = decoded.sampleRate * clip.speed / 16000;
    for (let i = 0; i < output.length; i++) {
      const position = sourceStart + i * stride;
      const at = Math.floor(position), mix = position - at;
      if (at >= decoded.length) break;
      let sample = 0;
      for (const channel of channels) sample += channel[at] * (1 - mix) + (channel[Math.min(at + 1, decoded.length - 1)] ?? 0) * mix;
      output[i] = clamp(sample / channels.length, -1, 1);
    }
    return output;
  } catch (error) {
    check();
    throw new Error(`Could not decode audio from this file. Try an MP3 or WAV source, or a standard H.264 MP4. ${(error as Error).message}`);
  } finally {
    void context.close();
  }
}

/** Form readable 2–5 second caption cards from Whisper's timestamped words. */
export function wordsToCaptions(chunks: WhisperChunk[], clipStart: number, clipLength: number, track: number): TextClip[] {
  const words = chunks.filter((chunk) => chunk.text.trim() && Number.isFinite(chunk.timestamp?.[0]))
    .map((chunk) => ({ text: chunk.text.trim(), start: clamp(chunk.timestamp[0], 0, clipLength), end: clamp(chunk.timestamp[1] ?? chunk.timestamp[0] + 0.5, 0, clipLength) }))
    .filter((word) => word.start < clipLength);
  const groups: typeof words[] = [];
  let group: typeof words = [];
  for (const word of words) {
    if (group.length && (word.start - group[0].start >= 3.6 || group.length >= 7 || word.start - group.at(-1)!.end > 0.75)) {
      groups.push(group);
      group = [];
    }
    group.push(word);
  }
  if (group.length) groups.push(group);
  return groups.map((part) => {
    const start = part[0].start;
    const end = Math.max(part.at(-1)!.end, start + 0.5);
    return makeText(clipStart + start, {
      kind: "caption", label: "Auto subtitle", text: part.map((word) => word.text).join(" ").replace(/\s+([,.!?;:])/g, "$1"),
      duration: Math.max(0.15, Math.min(end + 0.12, clipLength) - start), track,
      fontSize: 48, y: 0.84, background: true,
    });
  });
}
