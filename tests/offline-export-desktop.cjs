// End-to-end production export through the UI. Never uses real projects/files.
const assert=require('node:assert/strict');
const path=require('node:path');
const {mkdir,writeFile,readFile,readdir}=require('node:fs/promises');
process.env.CUTLINE_LAYOUT_TEST='1';
process.env.CUTLINE_TEST_PROFILE=path.resolve('work/offline-export-desktop-profile');
const {app,BrowserWindow,ipcMain,dialog}=require('electron');
const {waitFor,importSyntheticProject}=require('./masking-desktop-layout.cjs');
app.whenReady().then(async()=>{
  const win=BrowserWindow.getAllWindows()[0],contents=win.webContents,run=code=>contents.executeJavaScript(code),errors=[];
  const file=path.resolve('work/disk-export-fixture/video.mp4');
  await mkdir(path.dirname(file),{recursive:true});await writeFile(file,'KEEP EXISTING VIDEO');
  let picks=0,writes=0,maxChunk=0,finished=0,firstWriteProgress=1,failWrite=false;
  dialog.showSaveDialog=async()=>++picks===1?{canceled:true}:{canceled:false,filePath:file};
  ipcMain.removeHandler('file:save');
  ipcMain.handle('file:save',()=>{throw new Error('Export attempted whole-file IPC save');});
  const write=ipcMain._invokeHandlers.get('export:write'),finish=ipcMain._invokeHandlers.get('export:finish');
  ipcMain.removeHandler('export:write');ipcMain.handle('export:write',async(event,payload)=>{
    if(failWrite)throw new Error('Simulated disk full');
    writes++;maxChunk=Math.max(maxChunk,payload.bytes.byteLength);
    if(writes===1)firstWriteProgress=await run(`document.querySelector('.export-progress progress').value`);
    return write(event,payload);
  });
  ipcMain.removeHandler('export:finish');ipcMain.handle('export:finish',async(event,payload)=>{const result=await finish(event,payload);finished++;return result;});
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
    await waitFor(()=>picks===1);
    await waitFor(()=>run(`Boolean(document.querySelector('.export-fields'))`));
    assert.equal(writes,0,'Destination cancel started encoding');assert.equal(await readFile(file,'utf8'),'KEEP EXISTING VIDEO');
    await run(`[...document.querySelectorAll('.dialog-actions button')].find(b=>b.textContent.includes('Export video')).click()`);
    await waitFor(()=>finished===1,90000);
    await waitFor(()=>run(`Boolean(document.querySelector('.export-success'))`));
    const saved=await readFile(file);
    assert.ok(maxChunk<=1024*1024&&writes>=2&&firstWriteProgress<1,'Output was not bounded/streamed during rendering');
    assert.ok(await run(`document.querySelector('.export-success').textContent.includes('Your video is saved.') && !document.querySelector('.export-success').textContent.includes('Save video again')`));
    const {Input,ALL_FORMATS,BlobSource,EncodedPacketSink}=await import('mediabunny');
    const input=new Input({formats:ALL_FORMATS,source:new BlobSource(new Blob([saved]))});
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
    assert.equal(finished,1,'Cancel saved partial output');assert.deepEqual(await readFile(file),saved,'Cancel replaced existing video');
    assert.deepEqual(await readdir(path.dirname(file)),['video.mp4'],'Partial output left after cancel');
    // Writer errors travel through real UI/IPC and leave the approved destination intact.
    failWrite=true;
    await run(`[...document.querySelectorAll('.dialog-actions button')].find(b=>b.textContent.includes('Export video')).click()`);
    await waitFor(()=>run(`Boolean(document.querySelector('.export-fields')) && document.querySelector('[aria-label="Export your video"]').textContent.includes('Simulated disk full')`),90000);
    assert.deepEqual(await readFile(file),saved);assert.deepEqual(await readdir(path.dirname(file)),['video.mp4']);
    assert.deepEqual(errors.filter(error=>!error.includes('Simulated disk full')),[],'Production renderer errors');
    console.log(JSON.stringify({passed:true,frames:count,fps:60,duration:last,resolution:'1280x720',audio:true,diskBacked:true,destinationCancel:true,cancel:true,writerFailure:true,writes,maxChunk,firstWriteProgress,file}));
    clearTimeout(timeout);app.exit(0);
  } catch(error) {console.error(error.stack,errors);clearTimeout(timeout);app.exit(1);}
});
