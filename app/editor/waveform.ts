export type WaveformData = { waveform: number[]; waveformPeaks: number[]; audioPeak: number };

/** Preserve both perceived loudness and short transients at timeline resolution. */
export function waveformFromBuffer(buffer: AudioBuffer): WaveformData {
  if (!buffer.length || !buffer.numberOfChannels) return { waveform: [], waveformPeaks: [], audioPeak: 0 };
  const bins = Math.min(buffer.length, Math.min(16384, Math.max(1024, Math.ceil(buffer.duration * 96))));
  const sums = new Float64Array(bins);
  const peaks = new Float32Array(bins);
  const counts = new Uint32Array(bins);
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  let audioPeak = 0;
  // Inspect every sample: subsampling misses short drum hits and understates the
  // true peak used for normalization, especially on longer recordings.
  for (let frame = 0; frame < buffer.length; frame++) {
    const bin = Math.min(bins - 1, Math.floor(frame / buffer.length * bins));
    let power = 0;
    let peak = 0;
    for (const channel of channels) {
      const value = Number.isFinite(channel[frame]) ? channel[frame] : 0;
      power += value * value;
      peak = Math.max(peak, Math.abs(value));
    }
    sums[bin] += power / channels.length;
    counts[bin]++;
    peaks[bin] = Math.max(peaks[bin], peak);
    audioPeak = Math.max(audioPeak, peak);
  }
  return {
    waveform: Array.from(sums, (sum, i) => counts[i] ? Math.sqrt(sum / counts[i]) : 0),
    waveformPeaks: Array.from(peaks),
    audioPeak,
  };
}

export async function analyzeAudioWaveform(blob: Blob): Promise<WaveformData | null> {
  // Avoid decoding larger compressed files a second time just for metadata.
  if (blob.size >= 64 * 1024 * 1024) return null;
  let context: AudioContext | null = null;
  try {
    context = new AudioContext();
    return waveformFromBuffer(await context.decodeAudioData(await blob.arrayBuffer()));
  } catch {
    return null;
  } finally {
    if (context && context.state !== "closed") await context.close().catch(() => {});
  }
}

/** Peak normalization targets -1 dBFS and stays within the editor's 200% gain range. */
export function normalizeAudioGain(asset: { audioPeak?: number; waveformPeaks?: number[] }, targetDb = -1): number | null {
  let peak = Number.isFinite(asset.audioPeak) ? Math.max(0, asset.audioPeak!) : 0;
  for (const value of asset.waveformPeaks ?? []) if (Number.isFinite(value)) peak = Math.max(peak, value);
  if (peak < 0.000001) return null;
  const target = Number.isFinite(targetDb) ? Math.min(0, targetDb) : -1;
  return Math.min(2, Math.max(0, 10 ** (target / 20) / peak));
}

export function waveformColumns(
  values: number[], peaks: number[] | undefined,
  sourceStart: number, sourceEnd: number, duration: number, columns: number,
): { rms: number; peak: number }[] {
  if (!values.length || !Number.isFinite(duration) || duration <= 0 || !Number.isFinite(columns) || columns <= 0 ||
      !Number.isFinite(sourceStart) || !Number.isFinite(sourceEnd) || sourceEnd <= sourceStart) return [];
  const count = Math.min(32768, Math.max(1, Math.floor(columns)));
  const result: { rms: number; peak: number }[] = [];
  for (let column = 0; column < count; column++) {
    const start = sourceStart + (sourceEnd - sourceStart) * column / count;
    const end = sourceStart + (sourceEnd - sourceStart) * (column + 1) / count;
    const first = Math.max(0, Math.min(values.length - 1, Math.floor(start / duration * values.length)));
    const last = Math.max(first + 1, Math.min(values.length, Math.ceil(end / duration * values.length)));
    let power = 0;
    let peak = 0;
    for (let i = first; i < last; i++) {
      const value = Number.isFinite(values[i]) ? Math.max(0, values[i]) : 0;
      power += value * value;
      const sourcePeak = peaks?.[i];
      peak = Math.max(peak, Number.isFinite(sourcePeak) ? Math.max(0, sourcePeak!) : value);
    }
    result.push({ rms: Math.sqrt(power / (last - first)), peak });
  }
  return result;
}
