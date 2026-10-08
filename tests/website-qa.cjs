// Static marketing-site QA. Does not read or write the user's editor profile.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
app.setPath('userData', path.resolve('work/website-qa-profile'));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1440, height: 1050, webPreferences: { backgroundThrottling: false } });
  const errors = [];
  win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  const run = code => win.webContents.executeJavaScript(code);
  await win.loadURL(process.env.CUTLINE_WEBSITE_URL || 'http://127.0.0.1:4187/');
  await run('document.querySelectorAll("img[loading=lazy]").forEach(i=>i.loading="eager");Promise.all([document.fonts.ready,...[...document.images].filter(i=>i.getAttribute("src")).map(i=>i.decode())])');
  const checks = await run(`(async()=>{
    const result={title:document.title,images:[...document.images].filter(i=>i.getAttribute('src')).every(i=>i.complete&&i.naturalWidth>0),downloads:[...document.querySelectorAll('a[href$=".exe"]')].map(a=>a.href),fonts:document.fonts.check('600 40px Manrope')&&document.fonts.check('400 14px Inter')};
    result.tabs=[];
    for(const tab of document.querySelectorAll('[role=tab]')){tab.click();await document.querySelector('#studio-image').decode();result.tabs.push({id:tab.id,selected:tab.getAttribute('aria-selected')==='true',label:document.querySelector('#gallery-panel').getAttribute('aria-labelledby')===tab.id})}
    document.querySelector('#tab-color').focus();document.querySelector('#tab-color').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));
    result.keyboardTab=document.activeElement.id==='tab-transitions'&&document.querySelector('#gallery-panel').getAttribute('aria-labelledby')==='tab-transitions';
    document.querySelector('#expand-gallery').click();await document.querySelector('#enlarged-image').decode();
    result.modal=document.querySelector('#screenshot-dialog').open&&document.querySelector('#enlarged-image').src.endsWith('studio-transitions.png');document.querySelector('#close-screenshot').click();result.close=!document.querySelector('#screenshot-dialog').open;
    document.querySelector('[data-open-view=scenes]').click();await document.querySelector('#enlarged-image').decode();result.sceneModal=document.querySelector('#enlarged-image').src.endsWith('scene-cuts.png');document.querySelector('#close-screenshot').click();
    document.querySelector('#tab-effects').click();await document.querySelector('#studio-image').decode();
    document.querySelector('summary').click();result.faq=document.querySelector('details').open;document.querySelector('summary').click();
    return result;
  })()`);
  assert.ok(checks.images && checks.fonts && checks.keyboardTab && checks.modal && checks.close && checks.sceneModal && checks.faq);
  assert.equal(checks.tabs.length, 7); assert.ok(checks.tabs.every(t => t.selected && t.label));
  assert.equal(checks.downloads.length, 3);
  assert.ok(checks.downloads.every(url => url.startsWith('https://github.com/ahpah-dev/Cutline---Open-source-video-editor/releases/download/v0.8.4/') && url.includes('0.8.4-x64.exe')));
  assert.ok(await run(`document.querySelector('.release-pill').textContent.includes('0.8.4') && !document.body.innerHTML.includes('0.8.3')`), 'Outdated release labels');
  await fs.mkdir('work/website-qa', { recursive: true });
  for (const [name, width, height, zoom] of [['desktop',1440,1050,1],['mobile',390,844,1],['text-zoom',980,1000,2]]) {
    win.setContentSize(width,height); win.webContents.setZoomFactor(zoom);
    await new Promise(r => setTimeout(r,180));
    await run('scrollTo({top:0,behavior:"instant"});new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    checks[name] = await run('({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,overflow:document.documentElement.scrollWidth>innerWidth+1})');
    if (checks[name].overflow) console.log(JSON.stringify(await run('({layout:{width:innerWidth,scrollWidth:document.documentElement.scrollWidth},offenders:[...document.querySelectorAll("body *")].filter(e=>{const r=e.getBoundingClientRect();return r.right>innerWidth+1&&r.width>0}).map(e=>({tag:e.tagName,cls:e.className,right:e.getBoundingClientRect().right,width:e.getBoundingClientRect().width})).slice(0,20)})')));
    for (const [suffix, selector] of [['','body'],['-features','#features'],['-download','#download']]) {
      await run(`document.querySelector('${selector}').scrollIntoView({behavior:'instant'});new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
      await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});
      await run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
      await fs.writeFile(path.resolve('work/website-qa/'+name+suffix+'.png'), (await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
    }
  }
  assert.deepEqual(errors, []); checks.errors=errors; console.log(JSON.stringify(checks));
  assert.ok(['desktop','mobile','text-zoom'].every(name => !checks[name].overflow), 'Horizontal overflow');
  win.destroy(); app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
