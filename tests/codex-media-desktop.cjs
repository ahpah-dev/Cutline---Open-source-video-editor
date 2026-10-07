// Real production UI/preload/IPC and media workers, with a test-only Codex transport.
// No inference/account usage. Optional CUTLINE_SPEECH_TEST=1 downloads free local Tiny.
const assert = require("node:assert/strict");
const path = require("node:path");
const { readFile, writeFile, mkdir } = require("node:fs/promises");
const { app, BrowserWindow } = require("electron");
process.env.CUTLINE_TEST_PROFILE = path.resolve("work/codex-media-profile-081");
process.env.CUTLINE_LAYOUT_TEST = "1";
const appMain = process.env.CUTLINE_TEST_APP_MAIN || path.resolve("electron/main.cjs");
const codexPath = path.join(path.dirname(appMain), "codex.cjs");
const exportsOriginal = require(codexPath);
let transport;
class TestConnection {
  constructor(options) {
    transport = this; this.emit = options.emit; this.runTool = options.runTool;
    this.state = { connected: false, needsLogin: false, busy: false, models: [{ id: "gpt-6.1-sol", name: "GPT-6.1 Sol", isDefault: true, reasoningEfforts: [{ id: "low", description: "Fast" }, { id: "high", description: "Deep" }], defaultEffort: "low", inputModalities: ["text", "image"] }] };
  }
  async connect(tools) { assert.equal(tools.length, 8); this.state.connected = true; this.emit({ type: "status", ...this.state }); return this.state; }
  async send(prompt, projectId, model, effort, images) { this.lastSend = { prompt, projectId, model, effort, images }; this.projectId = projectId; return { threadId: "test" }; }
  reset() {}
  async stop() { this.state.busy = false; }
  disconnect() { this.state.connected = false; this.emit({ type: "status", ...this.state }); }
}
require.cache[require.resolve(codexPath)].exports = { ...exportsOriginal, CodexConnection: TestConnection };
const { waitFor, importSyntheticProject } = require("./masking-desktop-layout.cjs");
const text = result => JSON.parse(result.contentItems.find(item => item.type === "inputText").text);
app.whenReady().then(async () => {
  const timeout = setTimeout(() => { console.error("Codex media desktop test timed out"); app.exit(1); }, process.env.CUTLINE_SPEECH_TEST === "1" ? 320000 : 90000);
  let win;
  try {
    win = BrowserWindow.getAllWindows()[0]; const contents = win.webContents; contents.setBackgroundThrottling(false);
    const errors = []; contents.on("console-message", event => { if (event.level === "error") errors.push(event.message); });
    await waitFor(() => contents.executeJavaScript('Boolean(document.querySelector(".codex-toggle") && !document.querySelector(".busy-indicator"))'));
    await importSyntheticProject(contents);
    await contents.executeJavaScript('document.querySelector(".codex-toggle").click()');
    await waitFor(() => contents.executeJavaScript('Boolean(document.querySelector(".codex-connect"))'));
    await contents.executeJavaScript('document.querySelector(".codex-connect").click()');
    await waitFor(() => contents.executeJavaScript('Boolean(document.querySelector("[aria-label=\\"Codex reasoning effort\\"]"))'));
    const options = await contents.executeJavaScript('[...document.querySelector("[aria-label=\\"Codex reasoning effort\\"]").options].map(o=>o.value)');
    assert.deepEqual(options, ["", "low", "high"]);
    const project = await contents.executeJavaScript(`(async()=>{ const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('cutline-local-projects',2);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)}); return await new Promise((resolve,reject)=>{const r=db.transaction('project').objectStore('project').get('current');r.onsuccess=()=>{db.close();resolve(r.result)};r.onerror=()=>reject(r.error)}); })()`);
    transport.projectId = project.id;
    const snapshot = text(await transport.runTool("cutline_get_project", {}));
    assert.equal(snapshot.mediaAccess.speech, false); assert.equal(snapshot.mediaAccess.nativeAudioInput, false);
    const sourceId = snapshot.assets.find(asset=>asset.name==='Blue hour landscape.png').id;
    const audioId = snapshot.clips.find(clip=>snapshot.assets.some(asset=>asset.id===clip.assetId&&asset.kind==='audio')).id;
    const source = await transport.runTool("cutline_view_source", { assetId: sourceId, sourceTime: 0 });
    assert.equal(source.success, true, JSON.stringify(source)); assert.ok(source.contentItems.some(item => item.type === "inputImage" && item.imageUrl.startsWith("data:image/png")));
    assert.equal(text(source).originalWidth, 1920); assert.equal(text(source).width, 1024); assert.equal(text(source).height, 576);
    const rhythm = await transport.runTool("cutline_analyze_audio", { clipId: audioId, mode: "rhythm", offset: 1, duration: 10 });
    assert.equal(rhythm.success, true, JSON.stringify(rhythm));
    const measured = text(rhythm); assert.ok(Math.abs(measured.bpm - 120) < 6); assert.ok(measured.beats.length > 10); assert.ok(measured.levels.peakDbFS < 0);
    assert.equal(measured.start.timelineSeconds, 1); assert.equal(measured.duration, 10);
    assert.equal(text(await transport.runTool("cutline_get_project", {})).revision, snapshot.revision, "Analysis changed the project");
    const speechDenied = await transport.runTool("cutline_analyze_audio", { clipId: audioId, mode: "speech", duration: 1 });
    assert.equal(speechDenied.success, false); assert.match(speechDenied.contentItems[0].text, /not enabled/);
    await contents.executeJavaScript(`(() => { document.querySelector('.codex-media-access').open=true; document.querySelector('.codex-media-access input').click(); })()`);
    await waitFor(async () => !text(await transport.runTool("cutline_get_project", {})).mediaAccess.imagesAndRhythm);
    assert.equal((await transport.runTool("cutline_view_source", { assetId: sourceId })).success, false);
    assert.equal((await transport.runTool("cutline_analyze_audio", { clipId: audioId, mode: "rhythm", duration: 1 })).success, false);
    await contents.executeJavaScript(`document.querySelector('.codex-media-access input').click()`);
    await waitFor(async () => text(await transport.runTool("cutline_get_project", {})).mediaAccess.imagesAndRhythm);
    await contents.executeJavaScript(`(() => {
      const canvas=document.createElement('canvas');canvas.width=2400;canvas.height=1200;const ctx=canvas.getContext('2d');const gradient=ctx.createLinearGradient(0,0,2400,1200);gradient.addColorStop(0,'#edb596');gradient.addColorStop(1,'#323a67');ctx.fillStyle=gradient;ctx.fillRect(0,0,2400,1200);
      const bytes=Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]),c=>c.charCodeAt(0));
      const transfer=new DataTransfer();transfer.items.add(new File([bytes],'Reference.png',{type:'image/png'}));
      const input=document.querySelector('.codex-composer input[type=file]');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));
    })()`);
    await waitFor(() => contents.executeJavaScript('Boolean(document.querySelector(".codex-reference-list.pending img"))'));
    const size = await contents.executeJavaScript(`new Promise(resolve=>{const img=new Image();img.onload=()=>resolve([img.naturalWidth,img.naturalHeight]);img.src=document.querySelector('.codex-reference-list.pending img').src})`);
    assert.deepEqual(size, [1024,512]);
    await contents.executeJavaScript(`(() => { const effort=document.querySelector('[aria-label="Codex reasoning effort"]');effort.value='high';effort.dispatchEvent(new Event('change',{bubbles:true}));const input=document.querySelector('.codex-composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'Use this visual reference');input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await waitFor(() => contents.executeJavaScript('!document.querySelector("[aria-label=\\"Send edit to Codex\\"]").disabled'));
    await contents.executeJavaScript('document.querySelector(".codex-composer").requestSubmit()');
    await waitFor(() => transport.lastSend?.effort === "high"); assert.equal(transport.lastSend.images.length,1); assert.equal(transport.lastSend.projectId,project.id);
    const cancel = transport.runTool("cutline_analyze_audio", { clipId: audioId, mode: "rhythm", duration: 16 });
    const cancelled = assert.rejects(cancel,/cancelled/);
    await contents.executeJavaScript('window.cutlineDesktop.codexStop()');
    await cancelled;
    await contents.executeJavaScript(`(() => {window.__nativeWorker=window.Worker;window.__mediaWorkerStarted=false;window.__mediaWorkerStopped=false;window.Worker=class extends window.__nativeWorker {postMessage(...args){window.__mediaWorkerStarted=true;this.delay=setTimeout(()=>super.postMessage(...args),1000)}terminate(){clearTimeout(this.delay);window.__mediaWorkerStopped=true;super.terminate()}}})()`);
    const interrupted = transport.runTool("cutline_analyze_audio", { clipId: audioId, mode: "rhythm", duration: 16 });
    await waitFor(() => contents.executeJavaScript('window.__mediaWorkerStarted'));
    await contents.executeJavaScript(`document.querySelector('.project-menu').open=true;[...document.querySelectorAll('.project-menu button')].find(button=>button.textContent.includes('My projects')).click()`);
    const blocked = await interrupted; assert.equal(blocked.success,false); assert.match(blocked.contentItems[0].text,/abort|cancel/i);
    assert.equal(await contents.executeJavaScript('window.__mediaWorkerStopped'),true,"Blocked editor did not terminate analysis worker");
    await contents.executeJavaScript("window.Worker=window.__nativeWorker;document.querySelector('[aria-label=\"Close dialog\"]').click();document.querySelector('.project-menu').open=false");
    await contents.executeJavaScript(`new Promise((resolve,reject)=>{
      const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;const ctx=canvas.getContext('2d');ctx.fillStyle='#ff0000';ctx.fillRect(0,0,320,180);
      const stream=canvas.captureStream(20),recorder=new MediaRecorder(stream,{mimeType:'video/webm'}),chunks=[];
      recorder.ondataavailable=e=>chunks.push(e.data);recorder.onerror=e=>reject(new Error('Fixture recording failed'));
      let frameTimer;recorder.onstop=()=>{clearInterval(frameTimer);stream.getTracks().forEach(t=>t.stop());const transfer=new DataTransfer();transfer.items.add(new File(chunks,'Source frames.webm',{type:'video/webm'}));const input=document.querySelector('input[accept="video/*,audio/*,image/*,.mkv,.mov,.m4a,.flac"]');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));resolve()};
      recorder.start();frameTimer=setInterval(()=>ctx.fillRect(0,0,320,180),50);setTimeout(()=>{ctx.fillStyle='#0000ff';ctx.fillRect(0,0,320,180)},600);setTimeout(()=>recorder.stop(),1300);
    })`);
    let videoAsset;
    await waitFor(async()=>{const result=await transport.runTool('cutline_get_project',{});if(!result.success)return false;videoAsset=text(result).assets.find(a=>a.name==='Source frames.webm');return videoAsset});
    const first=await transport.runTool('cutline_view_source',{assetId:videoAsset.id,sourceTime:0}),last=await transport.runTool('cutline_view_source',{assetId:videoAsset.id,sourceTime:.9});
    assert.equal(first.success,true,JSON.stringify(first));assert.equal(last.success,true,JSON.stringify(last));
    const pixels=await contents.executeJavaScript(`Promise.all(${JSON.stringify([first,last].map(r=>r.contentItems.find(i=>i.type==='inputImage').imageUrl))}.map(url=>new Promise(resolve=>{const image=new Image();image.onload=()=>{const canvas=document.createElement('canvas');canvas.width=1;canvas.height=1;const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0,1,1);resolve([...ctx.getImageData(0,0,1,1).data])};image.src=url})))`);
    assert.ok(pixels[0][0]>200&&pixels[0][2]<30,JSON.stringify(pixels));assert.ok(pixels[1][2]>200&&pixels[1][0]<30,JSON.stringify(pixels));
    assert.equal((await transport.runTool('cutline_view_source',{assetId:videoAsset.id,sourceTime:100})).success,false);
    // Re-enable optional speech using the same UI control the user sees.
    if (process.env.CUTLINE_SPEECH_TEST === "1") {
      const wav = await readFile(path.resolve("work/codex-speech-test.wav"));
      await contents.executeJavaScript(`(() => { const transfer=new DataTransfer();transfer.items.add(new File([Uint8Array.from(atob(${JSON.stringify(wav.toString("base64"))}),c=>c.charCodeAt(0))],'Speech test.wav',{type:'audio/wav'}));const input=document.querySelector('input[accept="video/*,audio/*,image/*,.mkv,.mov,.m4a,.flac"]');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true})); })()`);
      let speechAsset;
      await waitFor(async () => { const result=await transport.runTool("cutline_get_project", {});if(!result.success)return false;speechAsset=text(result).assets.find(a=>a.name==='Speech test.wav');return speechAsset; });
      const current = text(await transport.runTool("cutline_get_project", {}));
      const applied = await transport.runTool("cutline_apply_edits", { projectId:project.id,expectedRevision:current.revision,operations:[{op:"add_clip",assetId:speechAsset.id,start:0,track:0,ref:"speech"}] });
      assert.equal(applied.success,true,JSON.stringify(applied));
      const speechClip = text(await transport.runTool("cutline_get_project", {})).clips.find(c=>c.assetId===speechAsset.id);
      await contents.executeJavaScript('document.querySelectorAll(".codex-media-access input")[1].click()');
      await waitFor(async () => text(await transport.runTool("cutline_get_project", {})).mediaAccess.speech);
      const result = await transport.runTool("cutline_analyze_audio",{clipId:speechClip.id,mode:"speech",duration:30});
      assert.equal(result.success,true,JSON.stringify(result)); const transcript=text(result);assert.match(transcript.transcript,/hello|welcome|video|cutline/i);assert.ok(transcript.segments.length>0);
      console.log("CUTLINE_CODEX_LOCAL_SPEECH",JSON.stringify({transcript:transcript.transcript,segments:transcript.segments.length}));
    }
    // Open settings for the documentation screenshot, without fabricating an AI reply.
    for (const [width,height] of [[1100,700],[1480,920]]) {
      win.setSize(width,height); await waitFor(() => contents.executeJavaScript(`innerWidth===${width}`));
      const layout = await contents.executeJavaScript(`(() => {const r=el=>{const b=el.getBoundingClientRect();return {left:b.left,right:b.right,bottom:b.bottom,top:b.top}};const panel=document.querySelector('.codex-panel');return {panel:r(panel),controls:[...panel.querySelectorAll('.codex-composer textarea,.codex-composer select,.codex-composer button')].filter(el=>el.getBoundingClientRect().width>0).map(r),scroll:document.documentElement.scrollWidth,width:innerWidth}})()`);
      assert.equal(layout.scroll,layout.width);
      for(const rect of layout.controls) {assert.ok(rect.left>=layout.panel.left-.5&&rect.right<=layout.panel.right+.5);assert.ok(rect.bottom<=layout.panel.bottom+.5);}
    }
    await mkdir(path.resolve("docs/screenshots"),{recursive:true});
    await contents.executeJavaScript("document.querySelector('.codex-media-access').open=false;document.querySelector('.codex-messages').scrollTop=0");
    await waitFor(() => contents.executeJavaScript('!document.querySelector(".toast")'));
    await contents.capturePage(undefined,{stayHidden:true,stayAwake:true});
    await contents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    await writeFile(path.resolve("docs/screenshots/codex-media.png"),(await contents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
    assert.deepEqual(errors,[]);
    console.log("CUTLINE_CODEX_MEDIA_UI_IPC_WORKERS_PASSED",JSON.stringify({bpm:measured.bpm,beats:measured.beats.length,sourceSize:[text(source).width,text(source).height],referenceSize:size,effort:transport.lastSend.effort}));
    clearTimeout(timeout);app.exit(0);
  } catch(error) { console.error(error.stack);if(win)await writeFile(path.resolve("work/codex-media-failure.png"),(await win.webContents.capturePage()).toPNG()).catch(()=>{});clearTimeout(timeout);app.exit(1); }
});
