const assert=require('node:assert/strict');
const path=require('node:path');
const {mkdir,writeFile}=require('node:fs/promises');
process.env.CUTLINE_LAYOUT_TEST='1';process.env.CUTLINE_TEST_PROFILE=path.resolve('work/beats-themes-profile-080');
const {app,BrowserWindow}=require('electron');
const {waitFor,importSyntheticProject}=require('./masking-desktop-layout.cjs');
app.whenReady().then(async()=>{
  const win=BrowserWindow.getAllWindows()[0],contents=win.webContents,run=code=>contents.executeJavaScript(code),errors=[];
  contents.setBackgroundThrottling(false);
  contents.on('console-message',event=>{if(event.level==='error')errors.push(event.message)});
  const timeout=setTimeout(()=>app.exit(1),60000);
  try{
    await waitFor(()=>run(`Boolean(document.querySelector('.timeline'))`));await importSyntheticProject(contents);
    await mkdir('docs/screenshots',{recursive:true});
    const styles=[];
    for(const theme of ['graphite','midnight','forest','light']){
      await run(`document.querySelector('.theme-picker').open=true;[...document.querySelectorAll('.theme-popover button')].find(b=>b.textContent.trim().startsWith(${JSON.stringify(theme[0].toUpperCase()+theme.slice(1))})).click();document.querySelector('.theme-picker').open=false;`);
      await waitFor(()=>run(`document.documentElement.dataset.theme===${JSON.stringify(theme)}`));
      await run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
      await new Promise(r=>setTimeout(r,250));
      styles.push(await run(`({theme:document.documentElement.dataset.theme,header:getComputedStyle(document.querySelector('.app-header')).backgroundColor,panel:getComputedStyle(document.querySelector('.library')).backgroundColor,text:getComputedStyle(document.body).color})`));
      if(theme==='light'){
        await contents.capturePage(undefined,{stayHidden:true,stayAwake:true});
        await run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
        await writeFile('docs/screenshots/theme-light.png',(await contents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
      }
    }
    assert.equal(new Set(styles.map(s=>s.header)).size,4,'Topbar did not follow every theme');assert.equal(new Set(styles.map(s=>s.panel)).size,4,'Panels did not follow every theme');
    await contents.reload();await waitFor(()=>run(`Boolean(document.querySelector('.timeline'))&&document.documentElement.dataset.theme==='light'`));
    // Readable geometry at the supported minimum, including Windows buttons.
    win.setContentSize(1100,700);await run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    const layout=await run(`({width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,export:document.querySelector('.header-actions>.primary').getBoundingClientRect().right,window:document.querySelector('.window-controls').getBoundingClientRect().right})`);
    assert.equal(layout.overflow,false);assert.ok(layout.export<=layout.width&&layout.window<=layout.width,JSON.stringify(layout));
    win.setContentSize(1480,920);
    await run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    await run(`document.querySelector('.theme-picker').open=true;[...document.querySelectorAll('.theme-popover button')].find(b=>b.textContent.startsWith('Midnight')).click();document.querySelector('.theme-picker').open=false;document.querySelector('[aria-label="Auto detect beats"]').click()`);
    await waitFor(()=>run(`Boolean(document.querySelector('.beat-dialog[open]'))`));
    await run(`[...document.querySelectorAll('.beat-dialog button')].find(b=>b.textContent.includes('Detect beats')).click()`);
    await waitFor(()=>run(`Boolean(document.querySelector('.beat-overview'))`));
    const result=await run(`({bpm:document.querySelector('.beat-stats strong').textContent,count:document.querySelectorAll('.beat-preview-line').length,error:document.querySelector('.beat-error')?.textContent})`);
    assert.ok(result.count>=24&&result.count<42,JSON.stringify(result));assert.ok(Math.abs(parseFloat(result.bpm)-120)<5,JSON.stringify(result));
    await contents.capturePage(undefined,{stayHidden:true,stayAwake:true});
    await run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    await writeFile('docs/screenshots/auto-beats.png',(await contents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
    const before=await run(`document.querySelectorAll('.ruler-markers .timeline-marker').length`);
    await run(`document.querySelector('.beat-dialog-actions .primary').click()`);
    await waitFor(()=>run(`!document.querySelector('.beat-dialog')&&document.querySelectorAll('.timeline-marker.auto').length>20`));
    assert.equal(await run(`document.querySelectorAll('.timeline-marker.moment').length`),1);
    await run(`document.querySelector('[aria-label="Undo"]').click()`);
    await waitFor(()=>run(`document.querySelectorAll('.timeline-marker.auto').length===0`));
    assert.equal(await run(`document.querySelectorAll('.ruler-markers .timeline-marker').length`),before);
    await run(`document.querySelector('[aria-label="Auto detect beats"]').click()`);
    await waitFor(()=>run(`Boolean(document.querySelector('.beat-dialog[open]'))`));
    await run(`[...document.querySelectorAll('.beat-dialog button')].find(b=>b.textContent.includes('Detect beats')).click()`);
    await run(`document.querySelector('[aria-label="Close beat detection"]').click()`);
    await new Promise(r=>setTimeout(r,250));assert.equal(await run(`!!document.querySelector('.beat-dialog')`),false);
    assert.deepEqual(errors,[]);console.log(JSON.stringify({styles,layout,result,undo:true,cancel:true,errors}));clearTimeout(timeout);app.exit(0);
  }catch(e){console.error(e);console.error(JSON.stringify(errors));await writeFile('work/beats-themes-failure.png',(await contents.capturePage()).toPNG());console.error(await run(`document.querySelector('.beat-error')?.textContent||''`));clearTimeout(timeout);app.exit(1);}
});
