# Cutline on GitHub Pages

Open the editor at https://ahpah-dev.github.io/Cutline---Open-source-video-editor/ . No install, account, watermark or subscription is required for editing and export.

Use a current desktop Chrome or Edge browser. Import local video, audio or images, arrange clips and text on the timeline, add effects/transitions, then Export. Supported export formats depend on the codecs available in the browser. Browser downloads assemble the video in memory; use the Windows app for long disk-backed exports.

Projects and media save in this browser's IndexedDB, not on GitHub. Different devices, browsers, browser profiles and website origins have separate workspaces. Clearing site data or browser eviction can remove them. Use **Backup** to download a `.cutline` project including media, then restore that backup on another device or the Windows app. Hosting the editor publicly does not publish your projects. Model downloads contact Hugging Face only after requesting local ML features; original footage/audio is not uploaded for those features.

The web app includes timeline editing, local media import, text styles/animations, effects, transitions, gradients, color grading, masks/cropping, beat/scene analysis, local captions, browser-supported export, and project backups. Codex/custom API connections require the Windows app's native bridge and are clearly marked as desktop-only. Large Whisper requires a browser/device with WebGPU. Tiny Whisper and object detection use the included WASM runtime; no cross-origin isolation headers are required for their single-threaded WASM path. Model availability and recognition accuracy depend on the model hosts and device; review results.

## Local build

```sh
npm ci --ignore-scripts
npm run build:pages
npm run test:pages
npm run preview:pages -- --host 127.0.0.1
```

Open the printed server address plus `/Cutline---Open-source-video-editor/`. `dist-pages` is the deployable static output; it contains no Electron binaries, user data or credentials. `CUTLINE_WEB_BASE` can override the leading/trailing-slash base path for forks or root-domain hosting.

## Publishing

The `.github/workflows/pages.yml` workflow builds and verifies static output on main pushes or manual dispatch, uploads a Pages artifact, then deploys it using the `github-pages` environment. Repository Settings → Pages must use **GitHub Actions**. Only the deploy job receives Pages write and OIDC permissions. No provider keys or third-party backend are required. The existing marketing website and Windows downloads remain separate.
