// Real production UI checks use generated media in an isolated profile only.
const assert = require('node:assert/strict');
const path = require('node:path');
const { mkdir, writeFile } = require('node:fs/promises');
process.env.CUTLINE_LAYOUT_TEST = '1';
process.env.CUTLINE_TEST_PROFILE = path.resolve('work/deletion-desktop-profile');
const { app, BrowserWindow } = require('electron');
const { waitFor, importSyntheticProject } = require('./masking-desktop-layout.cjs');
app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0], contents = win.webContents;
  const run = code => contents.executeJavaScript(code);
  const errors = [];
  contents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  const timeout = setTimeout(() => { console.error('Deletion desktop test timed out'); app.exit(1); }, 90000);
  try {
    await waitFor(() => run('Boolean(document.querySelector("[aria-label=Playhead]"))'));
    await importSyntheticProject(contents, true);
    const media = '[aria-label="Delete Blue hour landscape.png from project"]';
    await run(`document.querySelector(${JSON.stringify(media)}).click()`);
    await waitFor(() => run(`Boolean(document.querySelector('[aria-label="Delete media?"]')?.open)`));
    assert.ok(await run(`document.querySelector('[aria-label="Delete media?"]').textContent.includes('1 timeline clip')`));
    assert.ok(await run(`!document.activeElement.classList.contains('destructive')`),'Dangerous default focus');
    for (const [width,height] of [[1100,700],[1480,920]]) {
      win.setContentSize(width,height);
      await run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
      const bounds = await run(`(()=>{const d=document.querySelector('[aria-label="Delete media?"]'),r=d.getBoundingClientRect();return{width:innerWidth,height:innerHeight,scroll:document.documentElement.scrollWidth,rect:{left:r.left,right:r.right,top:r.top,bottom:r.bottom},overflow:d.scrollWidth>d.clientWidth+1}})()`);
      assert.equal(bounds.scroll,width,'Workspace overflow');
      assert.ok(!bounds.overflow && bounds.rect.left>=0 && bounds.rect.right<=width && bounds.rect.top>=0 && bounds.rect.bottom<=height,'Confirmation overflow');
    }
    await contents.capturePage(undefined,{stayHidden:true,stayAwake:true});
    await run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    await mkdir('work',{recursive:true});
    await writeFile('work/deletion-confirmation.png',(await contents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
    await run(`document.querySelector('[aria-label="Delete media?"] .secondary').click()`);
    await waitFor(() => run(`!document.querySelector('[aria-label="Delete media?"]')`));
    assert.ok(await run(`Boolean(document.querySelector(${JSON.stringify(media)}))`),'Cancel removed media');
    await run(`document.querySelector(${JSON.stringify(media)}).click()`);
    await waitFor(() => run(`Boolean(document.querySelector('[aria-label="Delete media?"]')?.open)`));
    await run(`document.querySelector('[aria-label="Delete media?"] .destructive').click()`);
    await waitFor(() => run(`!document.querySelector(${JSON.stringify(media)})`));
    assert.ok(await run(`!document.querySelector('[data-clip-id="mask-base"]')`),'Used clip remained');
    await new Promise(resolve=>setTimeout(resolve,350));
    await run(`document.querySelector('[aria-label="Undo"]').click()`);
    await waitFor(() => run(`Boolean(document.querySelector(${JSON.stringify(media)}) && document.querySelector('[data-clip-id="mask-base"]'))`));
    // Audio tab gets the same safe delete action.
    await run(`[...document.querySelectorAll('.library-nav button')].find(b=>b.textContent.includes('Audio')).click()`);
    await waitFor(() => run(`Boolean(document.querySelector('[aria-label="Delete Ambient rhythm.wav from project"]'))`));
    await run(`document.querySelector('[aria-label="Delete Ambient rhythm.wav from project"]').click()`);
    await waitFor(() => run(`Boolean(document.querySelector('[aria-label="Delete media?"]')?.open)`));
    await run(`document.querySelector('[aria-label="Delete media?"] .secondary').click()`);
    await run(`[...document.querySelectorAll('.project-menu button')].find(b=>b.textContent.includes('My projects')).click()`);
    await waitFor(() => run(`Boolean(document.querySelector('[aria-label="Delete project COLOR STORIES / The quiet between"]'))`));
    await run(`document.querySelector('[aria-label="Delete project COLOR STORIES / The quiet between"]').click()`);
    await waitFor(() => run(`Boolean(document.querySelector('[aria-label="Delete project?"]')?.open)`));
    await run(`document.querySelector('[aria-label="Delete project?"] .destructive').click()`);
    await waitFor(() => run(`!document.querySelector('[aria-label="Delete project?"]') && !document.querySelector('[aria-label="Delete project COLOR STORIES / The quiet between"]')`));
    await run(`document.querySelector('[aria-label="My projects"] [aria-label="Close dialog"]').click()`);
    assert.ok(await run(`!document.querySelector('[data-clip-id="mask-base"]') && document.querySelector('[aria-label="Undo"]').disabled`),'Deleted project still in workspace/history');
    assert.deepEqual(errors,[],'Production renderer errors');
    console.log(JSON.stringify({passed:true,checks:['Media confirmation and safe focus','Cancel/delete/Undo after autosave','Audio delete action','Project deletion and history reset','Layout at 1100 and 1480 pixels'],screenshot:path.resolve('work/deletion-confirmation.png')}));
    clearTimeout(timeout); app.exit(0);
  } catch(error) { console.error(error.stack); clearTimeout(timeout); app.exit(1); }
});
