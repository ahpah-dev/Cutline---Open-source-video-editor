import { makeClip, newProject } from "../app/editor/model";
import { exportFormats, exportProject, inspectFile, MediaPool } from "../app/editor/media";
import { normalizeAudioGain, waveformFromBuffer } from "../app/editor/waveform";

type Check = (name: string, run: () => unknown) => Promise<void>;
const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };

function toneFile() {
  const rate = 48000, frames = 38400, bytes = new ArrayBuffer(44 + frames * 2), view = new DataView(bytes);
  const text = (at: number, value: string) => Array.from(value).forEach((character, index) => view.setUint8(at + index, character.charCodeAt(0)));
  text(0, "RIFF"); view.setUint32(4, bytes.byteLength - 8, true); text(8, "WAVE");
  text(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, "data"); view.setUint32(40, frames * 2, true);
  for (let frame = 0; frame < frames; frame++) view.setInt16(44 + frame * 2, Math.sin(frame / rate * Math.PI * 880) * 12000, true);
  return new File([bytes], "pan-tone.wav", { type: "audio/wav" });
}

/** Actual encoder and source lifetime checks; used by the Electron engine suite. */
export async function runAudioReliabilityChecks(check: Check) {
  await check("Audio peak normalization preserves true transients and handles silence", () => {
    const source = new AudioBuffer({ sampleRate: 48000, length: 48000, numberOfChannels: 2 });
    source.getChannelData(0).fill(0.2);
    source.getChannelData(1)[173] = -0.9;
    const analysis = waveformFromBuffer(source);
    assert(Math.abs(analysis.audioPeak - 0.9) < 0.000001, "Short transient peak was lost");
    const gain = normalizeAudioGain(analysis)!;
    assert(Math.abs(gain * analysis.audioPeak - 10 ** (-1 / 20)) < 0.000001, "Normalization misses its -1 dBFS target");
    assert(normalizeAudioGain({ audioPeak: 0, waveformPeaks: [0, 0] }) === null, "Silence should not amplify");
    assert(normalizeAudioGain({ waveformPeaks: [0.02] }) === 2, "Normalization exceeds the supported gain range");
  });

  await check("Stereo pan and mute are encoded in the actual exported audio", async () => {
    const asset = await inspectFile(toneFile());
    const project = newProject(); project.assets = [asset];
    const clip = { ...makeClip(asset), audioPan: -1 };
    project.clips = [clip];
    const context = new AudioContext();
    try {
      const format = exportFormats()[0];
      assert(format, "No export encoder available");
      const blob = await exportProject(project, { resolution: 144, fps: 30, mime: format.mime,
        signal: new AbortController().signal, onProgress() {} });
      const result = await context.decodeAudioData(await blob.arrayBuffer());
      assert(result.numberOfChannels === 2, "Panned output is not stereo");
      const peaks = [0, 0];
      for (let channel = 0; channel < 2; channel++) for (const sample of result.getChannelData(channel)) peaks[channel] = Math.max(peaks[channel], Math.abs(sample));
      assert(peaks[0] > 0.1 && peaks[1] < peaks[0] * 0.05, `Hard left pan is wrong: ${peaks}`);
      project.mutedTracks = [`layer:${clip.track}`];
      const silent = await exportProject(project, { resolution: 144, fps: 30, mime: format.mime,
        signal: new AbortController().signal, onProgress() {} });
      const muted = await context.decodeAudioData(await silent.arrayBuffer());
      let max = 0;
      for (let channel = 0; channel < muted.numberOfChannels; channel++) for (const sample of muted.getChannelData(channel)) max = Math.max(max, Math.abs(sample));
      assert(max < 0.001, "Muted project leaked exported audio");
    } finally {
      await context.close();
      if (asset.url) URL.revokeObjectURL(asset.url);
    }
  });

  await check("Cancelled and replaced media loads do not restore removed sources", async () => {
    const canvas = document.createElement("canvas"); canvas.width = 8; canvas.height = 8;
    const url = canvas.toDataURL("image/png");
    const project = newProject(); project.assets = [{ id: "source-lifetime", name: "Source", kind: "image", duration: 1, url, sizeLabel: "1 KB", theme: "image" }];
    project.clips = [makeClip(project.assets[0])];
    const pool = new MediaPool();
    try {
      const loading = pool.ensure(project);
      await pool.ensure({ ...project, clips: [] });
      await loading;
      assert(pool.sources.size === 0, "An old image load resurrected a removed clip");
      await pool.ensure(project);
      assert(pool.sources.size === 1, "Source did not reload after removing it");
      await pool.ensure({ ...project, assets: project.assets.map((asset) => ({ ...asset, url: undefined })) });
      assert(pool.sources.size === 0, "A missing source URL retained old media");
    } finally { pool.dispose(); }
  });
}
