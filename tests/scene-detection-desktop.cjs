// Actual production renderer/preload, isolated from the user's project library.
const assert = require("node:assert/strict");
const path = require("node:path");
const { mkdir, writeFile } = require("node:fs/promises");
process.env.CUTLINE_LAYOUT_TEST = "1";
process.env.CUTLINE_TEST_PROFILE = path.resolve("work/scene-detection-desktop-profile");
const { app, BrowserWindow } = require("electron");
const { waitFor, importSyntheticProject } = require("./masking-desktop-layout.cjs");

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0], contents = win.webContents, run = code => contents.executeJavaScript(code);
  contents.setBackgroundThrottling(false); const errors = [];
  contents.on("console-message", event => { if (event.level === "error") errors.push(event.message); });
  const timeout = setTimeout(() => app.exit(1), 60000);
  try {
    await waitFor(() => run("Boolean(document.querySelector('.timeline'))")); await importSyntheticProject(contents);
    await run(`new Promise(resolve => {
      const c=document.createElement('canvas');c.width=320;c.height=180;const ctx=c.getContext('2d');
      const stream=c.captureStream(30),recorder=new MediaRecorder(stream,{mimeType:'video/webm'}),chunks=[];
      let color='#f24b55';const paint=()=>{ctx.fillStyle=color;ctx.fillRect(0,0,320,180);ctx.fillStyle='#f8edd6';ctx.fillRect(110,35,100,110)};
      paint();recorder.ondataavailable=e=>chunks.push(e.data);recorder.onstop=()=>{
        clearInterval(timer);stream.getTracks().forEach(t=>t.stop());const transfer=new DataTransfer();
        transfer.items.add(new File(chunks,'Three shots.webm',{type:'video/webm'}));const input=document.querySelector('input[accept="video/*,audio/*,image/*,.mkv,.mov,.m4a,.flac"]');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));resolve();
      };
      recorder.start();const timer=setInterval(paint,33);setTimeout(()=>{color='#2447d6';paint()},800);setTimeout(()=>{color='#218652';paint()},1600);setTimeout(()=>recorder.stop(),2400);
    })`);
    await waitFor(() => run(`Boolean(document.querySelector('[aria-label="Add Three shots.webm to timeline"]'))`));
    await run(`document.querySelector('[aria-label="Add Three shots.webm to timeline"]').click();document.querySelector('[aria-label="Auto detect scene cuts"]').click()`);
    await waitFor(() => run(`Boolean(document.querySelector('.scene-dialog[open]'))`));
    await run(`[...document.querySelectorAll('.scene-dialog button')].find(b=>b.textContent.includes('Detect scene cuts')).click()`);
    await waitFor(() => run(`document.querySelectorAll('.scene-cut').length===2`));
    for (const [width,height] of [[1100,700],[1480,920]]) {
      win.setContentSize(width,height); await run("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
      const layout = await run(`(()=>{const dialog=document.querySelector('.scene-dialog'),r=dialog.getBoundingClientRect();return{width:innerWidth,scroll:document.documentElement.scrollWidth,left:r.left,right:r.right,top:r.top,bottom:r.bottom,overflow:dialog.scrollWidth>dialog.clientWidth,toolbar:[...document.querySelectorAll('.timeline-toolbar button')].map(b=>b.getBoundingClientRect().right)}})()`);
      assert.equal(layout.scroll,width,"Workspace horizontally overflowed");
      assert.ok(layout.left>=0&&layout.right<=width&&layout.top>=0&&layout.bottom<=height,"Review dialog clipped");
      assert.equal(layout.overflow,false,"Scene review overflows horizontally");
      assert.ok(layout.toolbar.every(right=>right<=width),"Timeline toolbar buttons overflow");
    }
    await contents.capturePage(undefined,{stayHidden:true,stayAwake:true});
    await run("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
    await mkdir("docs/screenshots",{recursive:true}); await writeFile("docs/screenshots/scene-cuts.png",(await contents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
    const count=await run("document.querySelectorAll('[data-clip-id]').length");
    await run(`document.querySelector('.scene-dialog .beat-dialog-actions .primary').click()`);
    await waitFor(() => run(`!document.querySelector('.scene-dialog')&&document.querySelectorAll('[data-clip-id]').length===${count+2}`));
    await run(`document.querySelector('[aria-label="Undo"]').click()`);
    await waitFor(() => run(`document.querySelectorAll('[data-clip-id]').length===${count}`));
    await run(`document.querySelector('[aria-label="Auto detect scene cuts"]').click()`);
    await waitFor(() => run(`Boolean(document.querySelector('.scene-dialog[open]'))`));
    await run(`[...document.querySelectorAll('.scene-dialog button')].find(b=>b.textContent.includes('Detect scene cuts')).click();document.querySelector('[aria-label="Close scene detection"]').click()`);
    await new Promise(resolve=>setTimeout(resolve,100)); assert.equal(await run("!!document.querySelector('.scene-dialog')"),false);
    assert.deepEqual(errors,[]); console.log(JSON.stringify({cuts:2,split:true,undo:true,cancel:true,layout:true,errors})); clearTimeout(timeout); app.exit(0);
  } catch(error) {
    console.error(error); console.error(await run("document.querySelector('.scene-dialog .beat-error')?.textContent||''"));
    await mkdir("work",{recursive:true}); await writeFile("work/scene-detection-failure.png",(await contents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG()); clearTimeout(timeout); app.exit(1);
  }
});
