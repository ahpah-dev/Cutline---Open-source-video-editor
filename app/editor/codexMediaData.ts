import { clipDuration, type Clip } from "./model";

export function audioWindow(clip: Clip, offset = 0, duration = 30) {
  const length = clipDuration(clip);
  if (!Number.isFinite(offset) || offset < 0 || offset >= length || !Number.isFinite(duration) || duration < .25 || duration > 120) throw new Error("Choose a valid audio window of 0.25–120 seconds within the clip.");
  const actual = Math.min(duration, length - offset);
  if (actual < .25) throw new Error("At least a quarter-second of audio must remain in the clip.");
  return { ...clip, start: clip.start + offset, sourceStart: clip.sourceStart + offset * clip.speed, sourceEnd: clip.sourceStart + (offset + actual) * clip.speed };
}

export function audioTiming(clip: Clip, seconds: number) {
  const time = Math.max(0, Math.min(clipDuration(clip), seconds));
  const round = (value: number) => Math.round(value * 1000) / 1000;
  return { windowSeconds: round(time), timelineSeconds: round(clip.start + time), sourceSeconds: round(clip.sourceStart + time * clip.speed) };
}

/** Levels are measured on decoded source audio, not the final mixed/filtered output. */
export function audioLevels(samples: Float32Array, sampleRate = 16000) {
  let sum = 0, peak = 0, clipped = 0;
  const silence: { start: number; end: number }[] = [];
  let silentStart: number | null = null;
  const block = Math.max(1, Math.round(sampleRate * .1));
  for (let i = 0; i < samples.length; i += block) {
    let blockSum = 0;
    const end = Math.min(samples.length, i + block);
    for (let j = i; j < end; j++) {
      const value = Number.isFinite(samples[j]) ? samples[j] : 0;
      const magnitude = Math.abs(value);
      sum += value * value; blockSum += value * value; peak = Math.max(peak, magnitude);
      if (magnitude >= .999) clipped++;
    }
    if (Math.sqrt(blockSum / (end - i)) < .003162) silentStart ??= i / sampleRate;
    else if (silentStart !== null) {
      if (i / sampleRate - silentStart >= .3) silence.push({ start: silentStart, end: i / sampleRate });
      silentStart = null;
    }
  }
  if (silentStart !== null && samples.length / sampleRate - silentStart >= .3) silence.push({ start: silentStart, end: samples.length / sampleRate });
  const db = (value: number) => value > 0 ? Math.round(20 * Math.log10(value) * 10) / 10 : null;
  return { rmsDbFS: db(Math.sqrt(sum / Math.max(1, samples.length))), peakDbFS: db(peak), clippedSamplePercent: Math.round(clipped / Math.max(1, samples.length) * 10000) / 100, silenceThresholdDbFS: -50, silence };
}
