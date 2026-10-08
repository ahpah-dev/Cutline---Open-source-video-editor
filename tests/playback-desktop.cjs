// Production Windows UI; only generated media in an isolated profile.
const assert=require('node:assert/strict');
const path=require('node:path');
process.env.CUTLINE_TEST_PROFILE=path.resolve('work/playback-desktop-profile');
process.env.CUTLINE_PLAYBACK_TEST='1';
const {app,BrowserWindow}=require('electron');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
const {waitFor,importSyntheticProject}=require('./masking-desktop-layout.cjs');
app.whenReady().then(async()=>{
  const win=BrowserWindow.getAllWindows()[0],contents=win.webContents,run=code=>contents.executeJavaScript(code),errors=[];
  contents.setBackgroundThrottling(false);
  assert.ok(contents.isOffscreen(),'Playback timing requires an offscreen compositor, not a hidden 1-fps window');
  contents.setFrameRate(60);contents.on('paint',()=>{});contents.startPainting();
  contents.on('console-message',event=>{if(event.level==='error')errors.push(event.message);});
  const timeout=setTimeout(()=>{console.error('Playback desktop test timed out');app.exit(1);},90000);
  try {
    await waitFor(()=>run('Boolean(document.querySelector("[aria-label=Playhead]"))'));
    await run(`window.testAudio=[];window.testFrames=[];const trace=now=>{window.testFrames.push(now);requestAnimationFrame(trace);};requestAnimationFrame(trace);const original=document.createElement.bind(document);document.createElement=function(tag,...args){const element=original(tag,...args);if(tag==='audio')window.testAudio.push(element);return element;};void 0;`);
    await importSyntheticProject(contents,true);
    // Capture synchronously at the actual DOM commit. MutationObserver delivery
    // can itself be deferred past the intentionally injected 100-ms stall.
    await run(`window.testCommits=[];const ruler=document.querySelector('[aria-label=Playhead]'),attribute=ruler.setAttribute.bind(ruler);ruler.setAttribute=function(name,value){attribute(name,value);if(name==='aria-valuenow'){const el=window.testAudio.find(e=>e.src&&e.duration===16);if(el&&!el.paused&&!el.seeking)window.testCommits.push({time:Number(value),source:el.currentTime,at:performance.now()});}};void 0;`);
    const snapshot=()=>run(`(()=>{const el=window.testAudio.find(e=>e.src&&e.duration===16);return {time:Number(document.querySelector('[aria-label=Playhead]').getAttribute('aria-valuenow')),source:el?.currentTime,paused:el?.paused,seeking:el?.seeking,play:Boolean(document.querySelector('[aria-label=Play]'))};})()`);
    const seek=async(target)=>{
      const points=await run(`(()=>{const r=document.querySelector('.ruler'),c=document.querySelector('.timeline-content'),next=r.querySelectorAll('span')[1],seconds=next.textContent.split(':').reduce((n,s)=>n*60+Number(s),0),pps=parseFloat(next.style.left)/seconds;return {x:c.getBoundingClientRect().left,y:r.getBoundingClientRect().top+8,pps};})()`);
      const x=Math.round(points.x+target*points.pps),y=Math.round(points.y);
      contents.sendInputEvent({type:'mouseMove',x:Math.round(points.x+.2*points.pps),y});
      contents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,x:Math.round(points.x+.2*points.pps),y});
      contents.sendInputEvent({type:'mouseMove',x:Math.round(points.x+2*points.pps),y});
      contents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x,y});
      await waitFor(async()=>{const s=await snapshot();return s.play&&s.paused&&!s.seeking&&Math.abs(s.time-target)<.05&&Math.abs(s.source-s.time)<.02;});
    };
    let maxDrift=0;const samples=[];
    for(const target of [5.75,.4,11.5,7.3]) {
      await seek(target);
      await run(`document.querySelector('[aria-label=Play]').click()`);
      await waitFor(async()=>{const s=await snapshot();return !s.paused&&s.time>target+.1;});
      for(let i=0;i<12;i++) {
        if(i===6)await run(`{const until=performance.now()+100;while(performance.now()<until){}};new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r())))`);
        // Compare a presented update, not arbitrary IPC sampling between frames
        // while the offscreen compositor has not scheduled a new paint yet.
        await run(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r())))`);
        const s=await snapshot();maxDrift=Math.max(maxDrift,Math.abs(s.time-s.source));samples.push({...s,target,i});
        assert.ok(!s.seeking&&!s.paused,'Unexpected playback interruption');
        await new Promise(resolve=>setTimeout(resolve,25));
      }
      await run(`document.querySelector('[aria-label=Pause]').click()`);
      await waitFor(async()=>(await snapshot()).paused);
    }
    const frameTimes=await run(`window.testFrames.slice(-20)`);
    const commits=await run(`window.testCommits`);
    const maxCommitDrift=Math.max(...commits.map(s=>Math.abs(s.time-s.source)));
    assert.ok(commits.length>25,'Not enough actual playhead commits');
    assert.ok(maxCommitDrift<.06,`Presented audio/playhead drift: ${maxCommitDrift}; ${JSON.stringify(commits.filter(s=>Math.abs(s.time-s.source)>.06))}`);
    assert.ok(maxDrift<.2,`UI failed to catch up after renderer scheduling/stalls: ${maxDrift}; frames: ${JSON.stringify(frameTimes)}; ${JSON.stringify(samples.filter(s=>Math.abs(s.time-s.source)>.2))}`);
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({passed:true,seeks:4,rapidDrag:true,mainThreadStallMs:100,maxPresentedDriftMs:maxCommitDrift*1000,maxBetweenFramesDriftMs:maxDrift*1000,profile:'isolated'}));
    clearTimeout(timeout);app.exit(0);
  } catch(error){console.error(error.stack,errors);clearTimeout(timeout);app.exit(1);}
});
