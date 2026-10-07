const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict');
const path=require('node:path');
app.setPath('userData',path.resolve('work/text-font-desktop-profile'));
const waitFor=async(fn)=>{const until=Date.now()+15000;while(Date.now()<until){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,40));}throw new Error('Text font desktop check timed out');};
app.whenReady().then(async()=>{
  const win=new BrowserWindow({show:false,width:1480,height:920,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  const timer=setTimeout(()=>app.exit(1),25000);
  const run=code=>win.webContents.executeJavaScript(code);
  try{
    await win.webContents.session.clearStorageData();
    await win.loadFile(path.resolve(process.env.CUTLINE_TEXT_TEST_HTML || 'dist-desktop/index.html'));
    await waitFor(()=>run(`Boolean(document.querySelector('.library-nav'))`));
    await run(`[...document.querySelectorAll('.library-nav button')].find(b=>b.textContent.trim()==='Text').click()`);
    await waitFor(()=>run(`Boolean(document.querySelector('.library-add'))`));
    await run(`document.querySelector('.library-add').click()`);
    await waitFor(()=>run(`Boolean(document.querySelector('.selection-box'))&&document.fonts.check('700 32px "Manrope Variable"','New Text')`));
    const result=await run(`(()=>{const canvas=document.querySelector('.preview-stage canvas'),box=document.querySelector('.selection-box'),select=document.querySelector('[aria-label="Font"]');
      const measure=document.createElement('canvas').getContext('2d');measure.font='800 '+86*canvas.width/1920+'px "Manrope Variable"';
      const expected=measure.measureText('New Text').width+40*canvas.width/1920;
      const actual=box.getBoundingClientRect().width/canvas.getBoundingClientRect().width*canvas.width;
      return {family:select.value,label:select.selectedOptions[0].textContent,expected,actual,loaded:[...document.fonts].filter(f=>f.family.includes('Manrope')&&f.status==='loaded').length};})()`);
    assert.equal(result.family,'Manrope Variable');assert.equal(result.label,'Manrope');assert.ok(result.loaded>0);
    assert.ok(Math.abs(result.expected-result.actual)<4,JSON.stringify(result));
    console.log('PRODUCTION_TEXT_FONT_MATCHES_INSPECTOR',JSON.stringify(result));clearTimeout(timer);app.exit(0);
  }catch(e){console.error(e);console.error(await run(`JSON.stringify({font:document.querySelector('[aria-label="Font"]')?.value,selection:!!document.querySelector('.selection-box'),toast:document.querySelector('.toast')?.textContent,clips:document.querySelectorAll('[data-clip-id]').length})`).catch(()=>''));clearTimeout(timer);app.exit(1);}
});
