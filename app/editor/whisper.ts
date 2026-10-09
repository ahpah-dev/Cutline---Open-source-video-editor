import { clamp, clipDuration, makeText, type Asset, type Clip, type TextClip } from "./model";
import { loadMediaAsset } from "../editorStorage";

export type WhisperChunk = { text: string; timestamp: [number, number | null] };
export const DEFAULT_SUBTITLE_WORDS_PER_LINE = 7;
export function normalizeSubtitleWordsPerLine(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.round(clamp(value, 1, 20)) : DEFAULT_SUBTITLE_WORDS_PER_LINE;
}
const SUBTITLE_LAYOUT_KEY = "cutline.subtitleWordsPerLine.v1";
export function readSubtitleWordsPerLine(): number {
  if (typeof window === "undefined") return DEFAULT_SUBTITLE_WORDS_PER_LINE;
  try {
    const saved = window.localStorage.getItem(SUBTITLE_LAYOUT_KEY);
    return saved === null ? DEFAULT_SUBTITLE_WORDS_PER_LINE : normalizeSubtitleWordsPerLine(Number(saved));
  } catch { return DEFAULT_SUBTITLE_WORDS_PER_LINE; }
}
export function saveSubtitleWordsPerLine(value: number): void {
  try { window.localStorage.setItem(SUBTITLE_LAYOUT_KEY, String(normalizeSubtitleWordsPerLine(value))); } catch { /* Optional preference; never block transcription. */ }
}

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

/** One-line caption cards. Real word times are preserved; multiword segments
 * (Large q4f16/fallback output) are split with estimated within-segment timing. */
export function wordsToCaptions(chunks: WhisperChunk[], clipStart: number, clipLength: number, track: number,
  options: { wordsPerLine?: number } = {}): TextClip[] {
  if (!Number.isFinite(clipLength) || clipLength <= 0) return [];
  const limit = normalizeSubtitleWordsPerLine(options.wordsPerLine);
  const timed = chunks.filter((chunk) => typeof chunk.text === "string" && chunk.text.trim() && Number.isFinite(chunk.timestamp?.[0]))
    .sort((a, b) => a.timestamp[0] - b.timestamp[0]);
  const words = timed.flatMap((chunk, index) => {
    const start = clamp(chunk.timestamp[0], 0, clipLength);
    if (start >= clipLength) return [];
    const next = timed[index + 1]?.timestamp[0];
    const fallbackEnd = Number.isFinite(next) && next > start ? next : clipLength;
    const end = clamp(typeof chunk.timestamp[1] === "number" && Number.isFinite(chunk.timestamp[1]) && chunk.timestamp[1] > start
      ? chunk.timestamp[1] : fallbackEnd, start, clipLength);
    const tokens = chunk.text.trim().replace(/\s+([,.!?;:])/g, "$1").split(/\s+/u);
    return tokens.map((text, i) => ({ text, start: start + (end - start) * i / tokens.length,
      end: start + (end - start) * (i + 1) / tokens.length }));
  });
  const groups: typeof words[] = [];
  let group: typeof words = [];
  for (const word of words) {
    if (group.length && (word.start - group[0].start >= 3.6 || group.length >= limit || word.start - group.at(-1)!.end > 0.75)) {
      groups.push(group);
      group = [];
    }
    group.push(word);
  }
  if (group.length) groups.push(group);
  return groups.map((part, index) => {
    const start = part[0].start;
    const end = Math.max(part.at(-1)!.end, start + 0.5);
    const nextStart = groups[index + 1]?.[0].start ?? clipLength;
    return makeText(clipStart + start, {
      kind: "caption", label: "Auto subtitle", text: part.map((word) => word.text).join(" ").replace(/\s+([,.!?;:])/g, "$1"),
      duration: Math.max(1 / 60, Math.min(end + 0.12, clipLength, nextStart) - start), track,
      fontSize: 48, y: 0.84, background: true,
    });
  });
}
