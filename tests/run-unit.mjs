import { build } from "vite";
import { spawnSync } from "node:child_process";
await build({
  configFile: false,
  logLevel: "warn",
  build: {
    outDir: "work/unit-tests",
    emptyOutDir: true,
    lib: {
      entry: {
        model: "tests/editor-model.test.ts",
        timeline: "tests/timeline-component.test.tsx",
        codex: "tests/codex-editing.test.ts",
        compositing: "tests/visual-compositing.test.ts",
        effects: "tests/effect-stack.test.tsx",
        color: "tests/color-detection.test.tsx",
        beats: "tests/beat-detection.test.ts",
        codexMedia: "tests/codex-media.test.ts",
        scenes: "tests/scene-detection.test.ts",
        textSequence: "tests/text-sequence.test.ts",
        mediaDeletion: "tests/media-deletion.test.ts",
        exportTiming: "tests/export-timing.test.ts",
        previewPlayback: "tests/preview-playback.test.ts",
        background: "tests/background.test.tsx",
        whisperLayout: "tests/whisper-layout.test.tsx",
      },
      formats: ["es"],
      fileName: (_format, name) => name + ".js",
    },
    rolldownOptions: {
      platform: "node",
      external: (id) =>
        id.startsWith("node:") ||
        /^(react|react-dom|jsdom|fflate)(\/|$)/.test(id),
    },
  },
});
const result = spawnSync(
  process.execPath,
  ["--test", "work/unit-tests/model.js", "work/unit-tests/timeline.js", "work/unit-tests/codex.js", "work/unit-tests/compositing.js", "work/unit-tests/effects.js", "work/unit-tests/color.js", "work/unit-tests/beats.js", "work/unit-tests/codexMedia.js", "work/unit-tests/scenes.js", "work/unit-tests/textSequence.js", "work/unit-tests/mediaDeletion.js", "work/unit-tests/exportTiming.js", "work/unit-tests/previewPlayback.js", "work/unit-tests/background.js", "work/unit-tests/whisperLayout.js"],
  { stdio: "inherit", env: { ...process.env, NODE_ENV: "test" } },
);
process.exitCode = result.status ?? 1;
