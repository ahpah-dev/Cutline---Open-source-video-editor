// Exercises the real compiled desktop renderer in a fresh profile, never the user's projects.
const { app, BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const path = require("node:path");
const { mkdir, writeFile } = require("node:fs/promises");
process.env.CUTLINE_TEST_PROFILE = path.resolve(`work/background-desktop-profile-${Date.now()}`);
process.env.CUTLINE_LAYOUT_TEST = "1";
process.env.CUTLINE_PLAYBACK_TEST = "1";
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  for (let i = 0; i < 120; i++) { const value = await check(); if (value) return value; await wait(100); }
  throw new Error("Timed out: " + label);
}
let running = false;
app.on("web-contents-created", (_event, contents) => {
  contents.setFrameRate(60); contents.on("paint", () => {}); contents.startPainting();
  contents.on("did-finish-load", async () => {
    if (running) return;
    running = true;
    const window = BrowserWindow.fromWebContents(contents); if (!window) return;
    const errors = [];
    contents.on("console-message", event => { if (event.level === "error") errors.push(event.message); });
    const js = code => contents.executeJavaScript(code);
    const saved = () => js(`new Promise((resolve,reject)=>{const open=indexedDB.open('cutline-local-projects',2);open.onerror=()=>reject(open.error);open.onsuccess=()=>{const db=open.result;const req=db.transaction('project').objectStore('project').get('current');req.onsuccess=()=>{resolve(req.result);db.close()};req.onerror=()=>{reject(req.error);db.close()}}})`);
    const click = async (selector, text) => { await js(`([...document.querySelectorAll(${JSON.stringify(selector)})].find(b=>${text ? `b.textContent.trim()===${JSON.stringify(text)}` : "true"})).click()`); await wait(100); };
    const set = async (label, value) => { await js(`(()=>{const input=document.querySelector('[aria-label="${label}"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}))})()`); await wait(100); };
    try {
      window.setSize(1440, 900);
      await until(() => js('Boolean(document.querySelector("[aria-label=\\"Background fill type\\"]") && !document.querySelector(".loading-project"))'), "editor ready");
      await click('[aria-label="Background fill type"] button', "Linear");
      await click('[aria-label="Background palettes"] button', "Sunset");
      await set("Background angle value", "35");
      await until(async () => (await saved())?.backgroundFill?.angle === 35, "saved linear gradient");
      await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); await wait(250);
      const samples = await js(`(()=>{const canvas=document.querySelector('.canvas-wrap canvas');if(!canvas)throw new Error('Missing player canvas');const ctx=canvas.getContext('2d');return [ctx.getImageData(10,10,1,1).data[0],ctx.getImageData(canvas.width-10,canvas.height-10,1,1).data[0]]})()`);
      assert.ok(Math.abs(samples[0] - samples[1]) > 50, "Player stayed solid: " + JSON.stringify(samples));
      assert.equal(await js('getComputedStyle(document.querySelector(".preview-empty")).backgroundColor'), "rgba(0, 0, 0, 0)", "Empty-player hint dims the gradient");
      await mkdir("work/background-verification", { recursive: true });
      await js('document.querySelector(".inspector-scroll").scrollTop=430');
      await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); await wait(200);
      await writeFile("work/background-verification/linear.png", (await contents.capturePage()).toPNG());
      await click('[aria-label="Background fill type"] button', "Radial");
      await set("Background center X value", "23"); await set("Background center Y value", "71");
      await set("Background radius value", "145");
      const project = await until(async () => { const p = await saved(); return p?.backgroundFill?.radius === 1.45 && p; }, "saved radial gradient");
      contents.reload(); await until(() => js('Boolean(document.querySelector("[aria-label=\\"Background radius value\\"]"))'), "reload controls");
      assert.equal(await js('document.querySelector("[aria-label=\\"Background radius value\\"]").value'), "145");
      assert.deepEqual((await saved()).backgroundFill, project.backgroundFill);
      await js('document.querySelector(".inspector-scroll").scrollTop=430');
      await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); await wait(250);
      await writeFile("work/background-verification/radial.png", (await contents.capturePage()).toPNG());
      assert.deepEqual(errors, []);
      console.log("BACKGROUND_DESKTOP_PASSED", JSON.stringify({ checks: ["linear palette", "angle", "real player pixels", "radial controls", "autosave", "reload", "no console errors"], screenshots: "work/background-verification" }));
      app.exit(0);
    } catch (error) { console.error(error.stack); app.exit(1); }
  });
});
require(process.env.CUTLINE_TEST_APP_MAIN || "../electron/main.cjs");
