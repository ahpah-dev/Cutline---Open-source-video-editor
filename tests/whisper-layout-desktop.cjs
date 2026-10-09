// Native UI/decoder/caption flow with a deterministic transcription-worker fixture.
// No speech model download, inference claim, paid provider or user profile access.
const { app, BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const path = require("node:path");
const { mkdir, writeFile } = require("node:fs/promises");
process.env.CUTLINE_TEST_PROFILE = path.resolve(`work/whisper-layout-profile-${Date.now()}`);
process.env.CUTLINE_LAYOUT_TEST = "1";
process.env.CUTLINE_PLAYBACK_TEST = "1";
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  for (let i = 0; i < 150; i++) { const value = await check(); if (value) return value; await wait(100); }
  throw new Error("Timed out: " + label);
}
app.on("web-contents-created", (_event, contents) => {
  contents.setFrameRate(60); contents.on("paint", () => {}); contents.startPainting();
  contents.once("did-finish-load", async () => {
    const window = BrowserWindow.fromWebContents(contents); if (!window) return;
    const errors = [];
    contents.on("console-message", event => { if (event.level === "error") errors.push(event.message); });
    const js = code => contents.executeJavaScript(code);
    const saved = () => js(`new Promise((resolve,reject)=>{const open=indexedDB.open('cutline-local-projects',2);open.onerror=()=>reject(open.error);open.onsuccess=()=>{const db=open.result;const req=db.transaction('project').objectStore('project').get('current');req.onsuccess=()=>{resolve(req.result);db.close()};req.onerror=()=>{reject(req.error);db.close()}}})`);
    const clickText = async text => { await js(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}).click()`); await wait(100); };
    const setWords = async count => { await js(`(()=>{const input=document.querySelector('[aria-label="Words per line"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(String(count))});input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}))})()`); await wait(100); };
    const injectWorker = () => js(`(()=>{
      const Original=window.Worker;
      window.Worker=function(url,options){if(!String(url).includes('whisper.worker'))return new Original(url,options);
        return {onmessage:null,onerror:null,onmessageerror:null,cancelled:false,terminate(){this.cancelled=true},postMessage(data){
          window.__whisperFixtureAudioLength=data.audio.length;
          if(!(data.audio instanceof Float32Array)||data.audio.length!==256000)throw new Error('Wrong real decoded audio');
          const text='One two three four five six seven eight nine ten eleven twelve';
          const chunks=data.model.includes('large')?[{text,timestamp:[0,6]}]:text.split(' ').map((text,i)=>({text,timestamp:[i*.5,(i+1)*.5]}));
          setTimeout(()=>{if(!this.cancelled)this.onmessage?.({data:window.__whisperTextOnly?{type:'done',text}:{type:'done',chunks,text}})},650);
        }};
      };
    })()`);
    const generate = async (count, fallback = false) => {
      await setWords(count); const before = (await saved()).texts.filter(t => t.kind === "caption").length;
      await js(`window.__whisperTextOnly=${fallback}`);
      await clickText("Download & transcribe");
      await until(() => js('document.querySelector("[aria-label=\\"Words per line\\"]")?.disabled'), "options locked while transcribing");
      const p = await until(async () => { const p = await saved(); return p?.texts.filter(t => t.kind === "caption").length > before && p; }, "new timed captions");
      const generated = p.texts.filter(t => t.kind === "caption").slice(before);
      assert.equal(generated.length, Math.ceil(12 / count));
      assert.ok(generated.every(t => t.text.split(/\s+/u).length <= count && t.duration > 0 && t.start + t.duration <= 16));
      assert.equal(generated.map(t => t.text).join(" "), "One two three four five six seven eight nine ten eleven twelve");
      return generated;
    };
    try {
      window.setSize(1440, 1000);
      await until(() => js('Boolean(document.querySelector(".timeline") && !document.querySelector(".loading-project"))'), "editor ready");
      await importSyntheticProject(contents);
      await injectWorker(); await clickText("Captions"); await clickText("Auto subtitles");
      await setWords(3);
      await mkdir("work/whisper-layout-verification", { recursive: true });
      await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); await wait(150);
      await writeFile("work/whisper-layout-verification/options.png", (await contents.capturePage()).toPNG());
      const three = await generate(3); assert.deepEqual(three.map(t => t.start), [0, 1.5, 3, 4.5]);
      await js('document.querySelector("[aria-label=\\"Deselect clip\\"]").click()'); await clickText("Auto subtitles");
      const one = await generate(1, true); assert.ok(one.at(-1).start > 10, "Fallback used detached audio length instead of real duration");
      await js('document.querySelector("[aria-label=\\"Deselect clip\\"]").click()'); await clickText("Auto subtitles");
      await js(`(()=>{const input=[...document.querySelectorAll('.subtitle-dialog select')][1];Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(input,'Xenova/whisper-tiny.en');input.dispatchEvent(new Event('change',{bubbles:true}))})()`);
      const tiny = await generate(5); assert.deepEqual(tiny.map(t => t.start), [0, 2.5, 5]);
      await js('document.querySelector("[aria-label=\\"Deselect clip\\"]").click()'); await clickText("Auto subtitles");
      assert.equal(await js('document.querySelector("[aria-label=\\"Words per line\\"]").value'), "5");
      await clickText("Not now");
      // Verify preference after a real native reload, not just dialog state.
      const waitLoaded = new Promise(resolve => contents.once("did-finish-load", resolve)); contents.reload(); await waitLoaded;
      await until(() => js('Boolean(document.querySelector(".timeline"))'), "reloaded project");
      await clickText("Captions"); await clickText("Auto subtitles");
      assert.equal(await js('document.querySelector("[aria-label=\\"Words per line\\"]").value'), "5");
      assert.deepEqual(errors, []);
      console.log("WHISPER_LAYOUT_DESKTOP_PASSED", JSON.stringify({ checks: ["real local audio decode", "Large 3-word segment captions", "1-word text-only fallback", "Tiny 5-word timed captions", "locked controls", "dialog persistence", "reload persistence", "no console errors"], fixture: "Mock transcription worker; model inference unchanged" }));
      app.exit(0);
    } catch (error) { console.error(error.stack); app.exit(1); }
  });
});
const { importSyntheticProject } = require("./masking-desktop-layout.cjs");
