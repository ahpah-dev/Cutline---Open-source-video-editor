import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

const base = process.env.CUTLINE_WEB_BASE || "/Cutline---Open-source-video-editor/";
const root = path.resolve("dist-pages");
test("Pages serves the actual editor with repository-scoped scripts, styles and favicon", async () => {
  const html = await readFile(path.join(root, "index.html"), "utf8");
  assert.match(html, /github-pages-web-editor/);
  assert.match(html, /id="root"/);
  assert.match(html, /Content-Security-Policy/);
  const assets = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(match => match[1]);
  assert.ok(assets.some(value => value.endsWith(".js")) && assets.some(value => value.endsWith(".css")));
  for (const url of assets) {
    const resolved = new URL(url, "https://example.test" + base);
    assert.equal(resolved.origin, "https://example.test");
    assert.ok(resolved.pathname.startsWith(base), "Asset escapes GitHub project path: " + url);
    assert.ok((await stat(path.join(root, resolved.pathname.slice(base.length)))).size > 0);
  }
});
test("Pages contains the self-hosted ML runtime, workers, fonts and licenses", async () => {
  await stat(path.join(root, ".nojekyll"));
  for (const name of ["ort-wasm-simd-threaded.jsep.mjs", "ort-wasm-simd-threaded.jsep.wasm"]) {
    assert.ok((await readFile(path.join(root, "whisper-runtime", name))).equals(await readFile(path.join("public", "whisper-runtime", name))));
  }
  const assets = await readdir(path.join(root, "assets"));
  assert.ok(assets.some(name => name.startsWith("whisper.worker") && name.endsWith(".js")));
  assert.ok(assets.some(name => name.startsWith("objectDetection.worker") && name.endsWith(".js")));
  assert.ok(assets.some(name => name.startsWith("manrope-") && name.endsWith(".woff2")));
  await stat(path.join(root, "licenses", "mediabunny-LICENSE.txt"));
  const names = await readdir(root);
  assert.ok(!names.some(name => /^(?:electron|node_modules|\.env|\.git)$/.test(name)));
});
