import { env, pipeline, RawImage, type ObjectDetectionPipelineType } from "@huggingface/transformers";
import { OBJECT_MODEL, normalizeDetections } from "./objectDetection";
type Request = { pixels: Uint8ClampedArray; width: number; height: number; runtimeUrl: string };
let detector: ObjectDetectionPipelineType | null = null;
env.useBrowserCache = true;
env.allowLocalModels = false;
self.onmessage = async (event: MessageEvent<Request>) => {
  let stage = "loading the object detector";
  try {
    const { pixels, width, height, runtimeUrl } = event.data;
    if (width < 1 || height < 1 || width * height > 640 * 640 || pixels.length !== width * height * 4) throw new Error("Invalid detection frame.");
    if (env.backends.onnx.wasm) { env.backends.onnx.wasm.wasmPaths = runtimeUrl; env.backends.onnx.wasm.numThreads = 1; }
    if (!detector) {
      self.postMessage({ type: "status", message: "Downloading the free local object detector…" });
      const createDetector = pipeline as unknown as (task: "object-detection", model: string, options: {
        device: "wasm"; dtype: "q8"; progress_callback: (progress: { status: string; progress?: number; file?: string }) => void;
      }) => Promise<ObjectDetectionPipelineType>;
      detector = await createDetector("object-detection", OBJECT_MODEL, { device: "wasm", dtype: "q8", progress_callback: (progress) => {
        if (progress.status === "progress") self.postMessage({ type: "progress", progress: progress.progress, file: progress.file });
      } });
    }
    stage = "analyzing the frame"; self.postMessage({ type: "status", message: "Finding objects on this device…" });
    const objects = await detector(new RawImage(pixels, width, height, 4), { threshold: .25, percentage: true });
    self.postMessage({ type: "done", objects: normalizeDetections(objects, .25) });
  } catch (error) {
    detector = null;
    const detail = error instanceof Error ? error.message : String(error);
    self.postMessage({ type: "error", message: /fetch|network/i.test(detail)
      ? "Could not download the detector. Check access to huggingface.co and try again. Your footage is never uploaded."
      : `Object detection failed while ${stage}: ${detail}` });
  }
};
