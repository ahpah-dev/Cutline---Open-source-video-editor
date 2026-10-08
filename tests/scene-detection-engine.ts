import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { saveMediaAsset } from "../app/editorStorage";
import { makeClip, newProject, type Asset } from "../app/editor/model";
import { SceneDetectionDialog } from "../app/editor/SceneDetectionDialog";
import { applySceneCuts, sceneSourceKey } from "../app/editor/sceneDetection";
import { scanScenes } from "../app/editor/sceneMedia";

type Check = (name: string, run: () => unknown) => Promise<void>;
type Assert = (condition: unknown, message: string) => void;
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(test: () => boolean, timeout = 10000) {
  const deadline = performance.now() + timeout;
  while (!test()) { if (performance.now() > deadline) throw new Error("Scene UI timed out"); await wait(20); }
}

export async function runSceneDetectionChecks(check: Check, assert: Assert) {
  const canvas = document.createElement("canvas"); canvas.width = 320; canvas.height = 180;
  const ctx = canvas.getContext("2d")!, stream = canvas.captureStream(30), recorder = new MediaRecorder(stream, { mimeType: "video/webm" });
  const chunks: BlobPart[] = [], boundaries: number[] = [];
  recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
  const stopped = new Promise<Blob>(resolve => { recorder.onstop = () => resolve(new Blob(chunks, { type: "video/webm" })); });
  ctx.fillStyle = "#ff0000"; ctx.fillRect(0, 0, 320, 180); recorder.start(); const start = performance.now();
  // Keep producing frames through the tail; a static capture stream ends at its last paint.
  const paint = setInterval(() => ctx.fillRect(0, 0, 320, 180), 33);
  for (const color of ["#0000ff", "#00ff00"]) {
    await wait(800); boundaries.push((performance.now() - start) / 1000);
    ctx.fillStyle = color; ctx.fillRect(0, 0, 320, 180);
  }
  await wait(800); clearInterval(paint); recorder.stop(); const blob = await stopped; stream.getTracks().forEach(track => track.stop());
  const asset: Asset = { id: "scene-engine-source", name: "Three shots.webm", kind: "video", duration: 2.4, theme: "video", sizeLabel: "Synthetic test", url: URL.createObjectURL(blob) };
  await saveMediaAsset({ ...asset, kind: "video", blob });
  const clip = { ...makeClip(asset), sourceEnd: 2.35 }, project = newProject(); project.assets = [asset]; project.clips = [clip];
  const settings = { sensitivity: 50, minimum: .125 };
  try {
    await check("Scene scan decodes real local video, finds two cuts, provides review frames, and honors trim/speed", async () => {
      const cuts = await scanScenes(clip, asset, 30, settings, new AbortController().signal, () => {});
      assert(cuts.length === 2, `Expected two hard cuts, got ${cuts.length}`);
      cuts.forEach((cut, i) => {
        assert(Math.abs(cut.time - boundaries[i]) < .09, `Cut timing off: ${cut.time} vs ${boundaries[i]}`);
        assert(!!cut.before?.startsWith("data:image/jpeg") && !!cut.after?.startsWith("data:image/jpeg"), "Source review frames missing");
      });
      const retimed = { ...clip, start: 5, sourceStart: .2, sourceEnd: 2.3, speed: 2 };
      const adjusted = await scanScenes(retimed, asset, 30, settings, new AbortController().signal, () => {});
      assert(adjusted.length === 2, "Retimed cuts missing");
      adjusted.forEach((cut, i) => assert(Math.abs(cut.time - (boundaries[i] - .2) / 2) < .065, "Trim/speed was not reflected"));
      const result = applySceneCuts(project, clip.id, sceneSourceKey(project, clip), cuts.map(cut => cut.time));
      assert(result.clips.length === 3 && result.clips.every(item => item.assetId === asset.id), "Detected scenes did not become source-linked clips");
    });
    await check("Scene scan supports cancellation and reports missing/oversized sources without modifying projects", async () => {
      const controller = new AbortController(); let cancelled = false;
      try { await scanScenes(clip, asset, 30, settings, controller.signal, () => controller.abort()); } catch (error) { cancelled = (error as Error).name === "AbortError"; }
      assert(cancelled, "Scan did not abort during frame decoding");
      let missing = false;
      try { await scanScenes({ ...clip, assetId: "missing" }, { ...asset, id: "missing", url: undefined }, 30, settings, new AbortController().signal, () => {}); } catch (error) { missing = (error as Error).message.includes("missing"); }
      assert(missing, "Missing source did not produce clear error");
      let oversized = false;
      try { await scanScenes({ ...clip, sourceEnd: 601 }, asset, 30, settings, new AbortController().signal, () => {}); } catch (error) { oversized = (error as Error).message.includes("10 minutes"); }
      assert(oversized && project.clips.length === 1, "Scan limits were not safe");
    });
    await check("Scene detection dialog reviews/excludes cuts, seeks previews and applies markers without changing the clip", async () => {
      const host = document.createElement("div"); document.body.appendChild(host); const root = createRoot(host);
      let closed = false, seeked = -1, result = project;
      try {
        root.render(createElement(SceneDetectionDialog, { project, initialClipId: clip.id, close: () => { closed = true; }, seek: time => { seeked = time; }, apply: (id, key, times, mode) => { result = applySceneCuts(project, id, key, times, mode); } }));
        await until(() => !!host.querySelector("dialog[open]"));
        const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.includes("Detect scene cuts"))!; button.click();
        await until(() => host.querySelectorAll(".scene-cut").length === 2);
        assert(project.clips.length === 1 && project.markers.length === 0, "Scanning modified the source project");
        host.querySelector<HTMLButtonElement>(".scene-cut-preview")!.click(); assert(seeked >= 0, "Preview did not seek");
        host.querySelector<HTMLInputElement>('[aria-label="Include scene cut 1"]')!.click(); await wait(30);
        const action = host.querySelector('[aria-label="Scene detection action"]') as unknown as HTMLSelectElement; action.value = "markers"; action.dispatchEvent(new Event("change", { bubbles: true })); await wait(30);
        [...host.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === "Add 1 markers")!.click();
        assert(result.clips === project.clips && result.markers.length === 1 && result.markers[0].kind === "moment", "Review/action selection was ignored");
        host.querySelector<HTMLButtonElement>('[aria-label="Close scene detection"]')!.click(); assert(closed, "Close button failed");
      } finally { root.unmount(); host.remove(); }
    });
  } finally { URL.revokeObjectURL(asset.url!); }
}
