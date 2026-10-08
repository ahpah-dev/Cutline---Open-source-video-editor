// End-to-end production export through the UI. Never uses real projects/files.
const assert=require('node:assert/strict');
const path=require('node:path');
const {mkdir,writeFile}=require('node:fs/promises');
process.env.CUTLINE_LAYOUT_TEST='1';
process.env.CUTLINE_TEST_PROFILE=path.resolve('work/offline-export-desktop-profile');
const {app,BrowserWindow,ipcMain}=require('electron');
const {waitFor,importSyntheticProject}=require('./masking-desktop-layout.cjs');
app.whenReady().then(async()=>{
  const win=BrowserWindow.getAllWindows()[0],contents=win.webContents,run=code=>contents.executeJavaScript(code),errors=[];
  const saved=[];
  ipcMain.removeHandler('file:save');
  ipcMain.handle('file:save',async(_event,payload)=>{
    assert.ok(payload.bytes instanceof ArrayBuffer,'Invalid exported bytes');
    const bytes=Buffer.from(payload.bytes);saved.push(bytes);
    await mkdir('work',{recursive:true});const file=path.resolve('work/offline-export-ui.mp4');await writeFile(file,bytes);
    return {canceled:false,filePath:file};
  });
  contents.on('console-message',event=>{if(event.level==='error')errors.push(event.message);});
  const timeout=setTimeout(()=>{console.error('Offline desktop export timed out');app.exit(1);},120000);
  try {
    await waitFor(()=>run('Boolean(document.querySelector("[aria-label=Playhead]"))'));
    await importSyntheticProject(contents,true);
    await run(`document.querySelector('.app-header .primary').click()`);
    await waitFor(()=>run(`Boolean(document.querySelector('.export-fields'))`));
    assert.ok(await run(`document.querySelector('.export-note').textContent.includes('constant frame rate')`),'Old export instructions');
    await run(`(()=>{const s=document.querySelectorAll('.export-fields select');s[1].value='720';s[1].dispatchEvent(new Event('change',{bubbles:true}));s[2].value='60';s[2].dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await run(`[...document.querySelectorAll('.dialog-actions button')].find(b=>b.textContent.includes('Export video')).click()`);
    await waitFor(()=>saved.length===1,90000);
    await waitFor(()=>run(`Boolean(document.querySelector('.export-success'))`));
    const {Input,ALL_FORMATS,BlobSource,EncodedPacketSink}=await import('mediabunny');
    const input=new Input({formats:ALL_FORMATS,source:new BlobSource(new Blob([saved[0]]))});
    let count=0,last=0;
    try {
      const video=await input.getPrimaryVideoTrack(),audio=await input.getPrimaryAudioTrack();
      assert.ok(video&&audio,'Missing video/audio');
      assert.equal(video.displayWidth,1280);assert.equal(video.displayHeight,720);
      for await(const p of new EncodedPacketSink(video).packets()) {
        assert.ok(Math.abs(p.timestamp*60-Math.round(p.timestamp*60))<.0001,'Uneven video frame timing');count++;last=Math.max(last,p.timestamp+p.duration);
      }
      assert.equal(count,960,'Missing frames in native 16-second / 60 fps export');assert.ok(Math.abs(last-16)<.002,'Wrong native export duration');
    } finally {input.dispose();}
    // Start a second export and cancel through the actual UI, not an injected AbortSignal.
    await run(`document.querySelector('[aria-label="Close dialog"]').click();document.querySelector('.app-header .primary').click()`);
    await waitFor(()=>run(`Boolean(document.querySelector('.export-fields'))`));
    await run(`[...document.querySelectorAll('.dialog-actions button')].find(b=>b.textContent.includes('Export video')).click()`);
    await waitFor(()=>run(`Boolean(document.querySelector('.export-progress button'))`));
    await run(`document.querySelector('.export-progress button').click()`);
    await waitFor(()=>run(`!document.querySelector('.export-progress')`));
    assert.equal(saved.length,1,'Cancel saved partial output');assert.deepEqual(errors,[],'Production renderer errors');
    console.log(JSON.stringify({passed:true,frames:count,fps:60,duration:last,resolution:'1280x720',audio:true,nativeSave:true,cancel:true,file:path.resolve('work/offline-export-ui.mp4')}));
    clearTimeout(timeout);app.exit(0);
  } catch(error) {console.error(error.stack,errors);clearTimeout(timeout);app.exit(1);}
});
