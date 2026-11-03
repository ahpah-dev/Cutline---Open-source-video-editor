import { pipeline, env } from "@huggingface/transformers";

env.useBrowserCache = true;
type Request = { audio: Float32Array; model: string; runtimeUrl: string };
type Chunk = { text: string; timestamp: [number, number | null] };
let transcriber: ((audio: Float32Array, options: Record<string, unknown>) => Promise<unknown>) | null = null;
let currentModel = "";
self.onmessage = async (event: MessageEvent<Request>) => {
  let stage = "starting";
  try {
    const { audio, model, runtimeUrl } = event.data;
    // Serve the matching ONNX runtime beside the app. A third-party CDN is not
    // required to start transcription, even on restricted networks.
    if (env.backends.onnx.wasm) {
      env.backends.onnx.wasm.wasmPaths = runtimeUrl;
      // Static hosts such as GitHub Pages do not supply COOP/COEP headers.
      if (!self.crossOriginIsolated) env.backends.onnx.wasm.numThreads = 1;
    }
    if (!transcriber || currentModel !== model) {
      stage = "loading the Whisper model";
      self.postMessage({ type: "status", message: "Downloading Whisper model…" });
      transcriber = await pipeline("automatic-speech-recognition", model, {
        // Full Large is too large for the WASM memory path. The q4f16 ONNX
        // build keeps its full model on GPU; Tiny remains for CPU-only PCs.
        ...(model === "onnx-community/whisper-large-v3-ONNX" ? { dtype: "q4f16", device: "webgpu" } : {}),
        progress_callback: (progress) => {
          if (progress.status === "progress") self.postMessage({ type: "progress", file: progress.file, progress: progress.progress });
          else if (progress.status === "ready") self.postMessage({ type: "status", message: "Whisper is ready." });
        },
      }) as unknown as typeof transcriber;
      currentModel = model;
    }
    stage = "transcribing audio";
    self.postMessage({ type: "status", message: "Transcribing audio on this device…" });
    const result = await transcriber!(audio, {
      // The q4f16 Large ONNX export omits cross-attention outputs required for
      // word alignment. Its native timestamp tokens still provide segment timing.
      return_timestamps: model === "onnx-community/whisper-large-v3-ONNX" ? true : "word",
      chunk_length_s: 30,
      stride_length_s: 5,
    });
    const output = Array.isArray(result) ? result[0] : result;
    const chunks = (output as { chunks?: Chunk[]; text?: string }).chunks ?? [];
    self.postMessage({ type: "done", chunks, text: (output as { text?: string }).text ?? "" });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const message = detail || "Unknown error.";
    self.postMessage({
      type: "error",
      message: /failed to fetch|fetch failed|networkerror/i.test(message)
        ? `Could not download the Whisper speech model while ${stage}. Check your connection to huggingface.co, then retry. The download is only needed once.`
        : `Whisper ${stage} failed: ${message}`,
    });
  }
};
