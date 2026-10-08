// Native production UI test; generated media and settings use an isolated profile.
const assert = require('node:assert/strict');
const path = require('node:path');
const { mkdir, writeFile } = require('node:fs/promises');
process.env.CUTLINE_LAYOUT_TEST = '1';
process.env.CUTLINE_TEST_PROFILE = path.resolve('work/text-sequence-desktop-profile');
const { app, BrowserWindow } = require('electron');
const { waitFor, importSyntheticProject } = require('./masking-desktop-layout.cjs');
app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0], contents = win.webContents;
  const run = code => contents.executeJavaScript(code);
  const errors = [];
  contents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  const timeout = setTimeout(() => { console.error('Text animation desktop test timed out'); app.exit(1); }, 90000);
  try {
    await waitFor(() => run('Boolean(document.querySelector("[aria-label=Playhead]"))'));
    await importSyntheticProject(contents, true);
    await run(`document.querySelector('[data-clip-id="mask-title"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`);
    await waitFor(() => run(`Boolean([...document.querySelectorAll('.inspector-tabs button')].find(b=>b.textContent==='Animation'))`));
    await run(`[...document.querySelectorAll('.inspector-tabs button')].find(b=>b.textContent==='Animation').click()`);
    await waitFor(() => run(`Boolean(document.querySelector('[aria-label="Entrance Letter Slide"]'))`));
    await run(`document.querySelector('[aria-label="Entrance Letter Slide"]').click()`);
    await waitFor(() => run(`Boolean(document.querySelector('[aria-label="Animate by"]'))`));
    await run(`(()=>{
      const select=document.querySelector('[aria-label="Animate by"]');select.value='word';select.dispatchEvent(new Event('change',{bubbles:true}));
    })()`);
    await run(`(()=>{
      const input=document.querySelector('[aria-label="Stagger value"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'80');input.dispatchEvent(new Event('input',{bubbles:true}));
    })()`);
    await waitFor(() => run(`document.querySelector('[aria-label="Animate by"]').value==='word' && document.querySelector('[aria-label="Stagger value"]').value==='80'`));
    await run(`document.querySelector('[aria-label="Entrance Word Pop"]').click()`);
    await waitFor(() => run(`document.querySelectorAll('[aria-label="Entrance animation stack"] button').length===2`));
    await run(`document.querySelector('[aria-label="Edit Letter Slide in entrance stack"]').click();document.querySelector('[aria-label="Preview entrance animation"]').click()`);
    await waitFor(() => run(`Number(document.querySelector('[aria-label="Playhead"]').getAttribute('aria-valuenow'))>.1`));
    // Pause the preview, then inspect both entrance and exit at native window sizes.
    await run(`document.querySelector('[aria-label="Pause"]')?.click()`);
    for(const [width,height] of [[1100,700],[1480,920]]) {
      win.setContentSize(width,height);
      await run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
      const layout=await run(`(()=>{const inspector=document.querySelector('.inspector'),r=inspector.getBoundingClientRect();return{width:innerWidth,scroll:document.documentElement.scrollWidth,inspectorWidth:inspector.clientWidth,inspectorScroll:inspector.scrollWidth,controls:[...inspector.querySelectorAll('button,input,select')].filter(e=>e.getBoundingClientRect().width>0).map(e=>{const b=e.getBoundingClientRect();return{label:e.getAttribute('aria-label')||e.textContent,left:b.left,right:b.right}}),left:r.left,right:r.right}})()`);
      assert.equal(layout.scroll,width,'Workspace overflow');
      assert.ok(layout.inspectorScroll<=layout.inspectorWidth+1,'Inspector overflow');
      for(const c of layout.controls) assert.ok(c.left>=layout.left-.5&&c.right<=layout.right+.5,`Overflow: ${c.label}`);
    }
    await waitFor(() => run('!document.querySelector(".toast")'));
    await run('document.fonts.ready');
    await run(`document.querySelector('.text-sequence-controls').scrollIntoView({block:'center'})`);
    await contents.capturePage(undefined,{stayHidden:true,stayAwake:true});
    await run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    await mkdir('docs/screenshots',{recursive:true});
    await writeFile('docs/screenshots/text-animations.png',(await contents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
    await run(`[...document.querySelectorAll('[aria-label="Animation phase"] button')].find(b=>b.textContent==='Exit').click()`);
    await waitFor(() => run(`Boolean(document.querySelector('[aria-label="Exit Letter Flip"]'))`));
    await run(`document.querySelector('[aria-label="Exit Letter Flip"]').click()`);
    await waitFor(() => run(`Boolean(document.querySelector('[aria-label="Flip axis"]'))`));
    assert.equal(await run(`document.querySelector('[aria-label="Flip axis"]').value`),'horizontal');
    assert.deepEqual(errors,[],'Production renderer errors');
    console.log(JSON.stringify({version:app.getVersion(),stack:2,nativeControls:true,preview:true,exit:true,layout:true,errors}));
    clearTimeout(timeout);app.exit(0);
  } catch(error) {
    await mkdir('work',{recursive:true});
    await writeFile('work/text-sequence-desktop-failure.png',(await contents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
    console.error(error);clearTimeout(timeout);app.exit(1);
  }
});
