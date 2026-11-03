// Browser-only production build: no preload, Electron bridge or user profile.
const { app, BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const path = require("node:path");
const { mkdir, readFile, stat, writeFile } = require("node:fs/promises");
const { unzipSync, strFromU8 } = require("fflate");
app.setPath("userData", path.resolve(`work/pages-browser-profile-${Date.now()}`));
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
const url = process.env.CUTLINE_PAGES_URL || "http://127.0.0.1:4189/Cutline---Open-source-video-editor/";
const directory = path.resolve("work/pages-verification");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await pause(100); }
  throw new Error("Timed out: " + label);
}
function audioFixture() {
  const rate = 16000, samples = rate;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(6000 * Math.sin(2 * Math.PI * 440 * i / rate)), 44 + i * 2);
  return wav.toString("base64");
}
app.whenReady().then(async () => {
  await mkdir(directory, { recursive:true });
  const win = new BrowserWindow({ show:false, width:1440, height:1000, webPreferences:{offscreen:true,backgroundThrottling:false} });
  const contents = win.webContents, errors = [], missing = [], downloads = [];
  contents.setFrameRate(60); contents.on("paint", () => {}); contents.startPainting();
  contents.on("console-message", event => { if (event.level === "error") errors.push(event.message); });
  contents.session.webRequest.onCompleted(details => { if (details.statusCode >= 400 && details.url.startsWith(new URL(url).origin)) missing.push({url:details.url,status:details.statusCode}); });
  contents.session.on("will-download", (_event, item) => {
    const file = path.join(directory, item.getFilename()); item.setSavePath(file);
    item.once("done", (_event,state) => { downloads.push({file,state}); });
  });
  const run = code => contents.executeJavaScript(code, true);
  const click = text => run(`[...document.querySelectorAll('button')].find(button=>button.textContent.trim()===${JSON.stringify(text)}).click()`);
  const current = () => run(`new Promise((resolve,reject)=>{const open=indexedDB.open('cutline-local-projects',2);open.onerror=()=>reject(open.error);open.onsuccess=()=>{const db=open.result;const req=db.transaction('project').objectStore('project').get('current');req.onsuccess=()=>{resolve(req.result);db.close()};req.onerror=()=>reject(req.error)}})`);
  try {
    await win.loadURL(url);
    await until(() => run('Boolean(document.querySelector(".timeline") && !document.querySelector(".busy-indicator"))'), "editor ready");
    assert.equal(await run('typeof window.cutlineDesktop'), "undefined");
    assert.equal(await run('document.querySelector(".web-welcome")?.open'), true);
    assert.equal(await run('document.activeElement.textContent'), "Open editor");
    await click("Open editor");
    assert.equal(await run('Boolean(document.querySelector(".window-controls"))'), false);
    await run(`(async()=>{
      const canvas=document.createElement('canvas');canvas.width=640;canvas.height=360;
      const ctx=canvas.getContext('2d');ctx.fillStyle='#315e9d';ctx.fillRect(0,0,640,360);ctx.fillStyle='#8bf0bd';ctx.fillRect(120,80,400,200);
      const image=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
      const audio=Uint8Array.from(atob(${JSON.stringify(audioFixture())}),char=>char.charCodeAt(0));
      const transfer=new DataTransfer();transfer.items.add(new File([image],'Browser scene.png',{type:'image/png'}));transfer.items.add(new File([audio],'Browser tone.wav',{type:'audio/wav'}));
      const input=document.querySelector('input[accept^="video/"]');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));
    })()`);
    await until(() => run('document.querySelectorAll(".asset-card").length===2 && !document.querySelector(".busy-indicator")'), "local image and audio import");
    for (const name of ["Browser scene.png", "Browser tone.wav"]) await run(`document.querySelector('[aria-label="Add ${name} to timeline"]').click()`);
    await run(`[...document.querySelectorAll('.library-nav button')].find(button=>button.textContent.trim()==='Text').click()`);
    await click("Add text");
    await until(() => run('Boolean(document.querySelector("[aria-label=\\"Text content\\"]"))'), "text inspector");
    await run(`(()=>{const input=document.querySelector('[aria-label="Text content"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'Cutline on the web');input.dispatchEvent(new Event('input',{bubbles:true}))})()`);
    const saved = await until(async () => { const project = await current(); return project?.texts.some(text=>text.text==='Cutline on the web') && project.clips.length===2 && project; }, "autosaved browser timeline");
    assert.equal(saved.assets.length, 2);
    assert.ok(saved.assets.find(asset=>asset.kind==='audio').waveformPeaks?.length > 0);
    await click("Backup");
    const backup = await until(() => downloads.find(item=>item.file.endsWith('.cutline') && item.state==='completed'), "downloaded project backup");
    const archive = unzipSync(await readFile(backup.file));
    assert.ok(JSON.parse(strFromU8(archive['project.json'])).texts.some(text=>text.text==='Cutline on the web'));
    assert.equal(Object.keys(archive).filter(name=>name.startsWith('media/')).length, 2);
    const loaded = new Promise(resolve=>contents.once('did-finish-load',resolve));contents.reload();await loaded;
    await until(() => run('document.querySelectorAll(".timeline-clip").length===3 && !document.querySelector(".busy-indicator")'), "timeline and media restored after reload");
    assert.equal(await run('Boolean(document.querySelector(".web-welcome"))'), false);
    assert.ok((await current()).texts.some(text=>text.text==='Cutline on the web'));
    await run('document.querySelector(".codex-toggle").click()');
    await until(() => run('document.querySelector(".codex-setup")?.textContent.includes("Windows")'), "desktop-only AI notice");
    assert.equal(await run('Boolean(document.querySelector("[aria-label=\\"API key\\"]"))'), false);
    await run('document.querySelector("[aria-label=\\"Close Codex panel\\"]").click()');
    await run('document.fonts.ready;new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');await pause(200);
    await writeFile(path.join(directory,'editor.png'),(await contents.capturePage()).toPNG());
    await run('document.querySelector(".header-actions>.button.primary").click()');
    await until(() => run('Boolean(document.querySelector(".export-fields"))'), "export dialog");
    await run(`(()=>{const selects=document.querySelectorAll('.export-fields select');const format=[...selects[0].options].find(option=>option.text.includes('VP8'));if(!format)throw Error('VP8 unavailable');for(const [select,value] of [[selects[0],format.value],[selects[1],'720']]){Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,value);select.dispatchEvent(new Event('change',{bubbles:true}));}})()`);
    await click("Export video");
    await until(() => run('Boolean(document.querySelector(".export-success"))'), "frame-accurate browser export", 90000);
    const video = await until(() => downloads.find(item=>item.file.endsWith('.webm') && item.state==='completed'), "downloaded exported video");
    const videoBytes = await readFile(video.file);
    assert.ok((await stat(video.file)).size>2000);assert.equal(videoBytes.subarray(0,4).toString('hex'),'1a45dfa3');
    assert.ok(videoBytes.includes(Buffer.from('OpusHead')), 'Export preserved imported audio');
    const metadata = await run(`new Promise((resolve,reject)=>{const bytes=Uint8Array.from(atob(${JSON.stringify(videoBytes.toString('base64'))}),char=>char.charCodeAt(0));const media=document.createElement('video');const source=URL.createObjectURL(new Blob([bytes],{type:'video/webm'}));media.onloadedmetadata=()=>{resolve({width:media.videoWidth,height:media.videoHeight,duration:media.duration});URL.revokeObjectURL(source)};media.onerror=()=>reject(Error('Export could not be decoded'));media.src=source;})`);
    assert.equal(metadata.width,1280);assert.equal(metadata.height,720);assert.ok(metadata.duration>=4.9);
    assert.deepEqual(missing,[]);assert.deepEqual(errors,[]);
    console.log('PAGES_BROWSER_PASSED',JSON.stringify({url,checks:['no desktop bridge','accessible welcome','image and audio import','audio peaks','timeline text edit','backup with source media','IndexedDB reload','desktop-only AI notice','VP8/Opus browser export','decoded 720p video','no console errors or missing assets'],metadata}));
    win.destroy();app.exit(0);
  } catch (error) { console.error(error.stack);console.error(JSON.stringify({errors,missing}));win.destroy();app.exit(1); }
}).catch(error=>{console.error(error.stack);app.exit(1);});
