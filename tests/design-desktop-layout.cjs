// An isolated, hidden Electron session tests the production UI, not a mockup.
const assert = require("node:assert/strict");
const path = require("node:path");
const { mkdir, writeFile } = require("node:fs/promises");
process.env.CUTLINE_TEST_PROFILE = path.resolve("work/design-layout-profile-070");
const { app, BrowserWindow } = require("electron");
const { waitFor, importSyntheticProject } = require("./masking-desktop-layout.cjs");

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0];
  let contents = win.webContents;
  const errors = [];
  contents.on("console-message", (event) => { if (event.level === "error") errors.push(event.message); });
  const timeout = setTimeout(() => { process.stderr.write("Design layout check timed out\n"); app.exit(1); }, 90000);
  const run = (source) => contents.executeJavaScript(source);
  const chooseLibrary = async (name) => {
    await run(`[...document.querySelectorAll('.library-nav button')].find(button=>button.textContent.trim()===${JSON.stringify(name)}).click()`);
    await waitFor(() => run(`Boolean(document.querySelector('[aria-label="Search ${name.toLowerCase()}"]'))`));
  };
  const selectClip = async (id) => {
    await run(`document.querySelector('[data-clip-id="${id}"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`);
    await waitFor(() => run('Boolean(document.querySelector(".selected-heading"))'));
  };
  const search = async (value) => {
    await run(`(() => { const input=document.querySelector('.library-search input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});
      input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  };
  const category = async (name) => {
    await run(`[...document.querySelectorAll('.library-categories button')].find(button=>button.textContent.trim()===${JSON.stringify(name)}).click()`);
  };
  const screenshot = async (name) => {
    await waitFor(() => run('!document.querySelector(".toast")'));
    await run('document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))');
    await mkdir(path.resolve("docs/screenshots"), { recursive: true });
    await writeFile(path.resolve(`docs/screenshots/${name}.png`), (await contents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
  };
  try {
    await waitFor(() => run('Boolean(document.querySelector(".timeline")&&!document.querySelector(".loading-project"))'));
    await importSyntheticProject(contents, true);
    await selectClip("mask-base");
    await chooseLibrary("Effects");
    await waitFor(() => run('document.querySelectorAll(".effect-card").length===34'));
    await waitFor(() => run('document.querySelectorAll(".preset-preview[data-preview-ready=true]").length>=4'));
    await run(`[...document.querySelectorAll('.effect-card')].find(button=>button.querySelector('strong').textContent==='Glow').click()`);
    await run(`[...document.querySelectorAll('.effect-card')].find(button=>button.querySelector('strong').textContent==='Vignette').click()`);
    await waitFor(() => run('document.querySelectorAll(".effect-stack-item").length===2'));
    await run(`document.querySelector('[aria-label="Move Glow later"]').click()`);
    await waitFor(() => run('document.querySelector(".effect-stack-heading strong").textContent==="Vignette"'));
    for (const [width, height] of [[1480,920],[1100,700],[1920,1080]]) {
      win.setSize(width,height);
      await waitFor(() => run(`innerWidth===${width}&&innerHeight===${height}`));
      await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      const layout = await run(`(() => {
        const rect=element=>{const r=element.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
        const inspector=document.querySelector('.inspector');
        return {width:innerWidth,height:innerHeight,documentWidth:document.documentElement.scrollWidth,
          font:getComputedStyle(document.body).fontFamily, workspace:rect(document.querySelector('.editing-workspace')),
          inspectorType:[...inspector.querySelectorAll('.field,.section-heading h3')].map(el=>parseFloat(getComputedStyle(el).fontSize)),
          toolbar:rect(document.querySelector('.timeline-toolbar')),footer:rect(document.querySelector('.timeline-footer')),
          nav:rect(document.querySelector('.library-nav')),guide:rect(document.querySelector('.help-nav')),
          inspector:rect(inspector),canvas:rect(document.querySelector('.canvas-wrap')),stage:rect(document.querySelector('.preview-stage')),
          library:rect(document.querySelector('.library-content')),
          controls:[...inspector.querySelectorAll('button,input,select')].map(el=>({label:el.getAttribute('aria-label')||el.textContent,rect:rect(el)})),
          cards:[...document.querySelectorAll('.effect-card')].map(rect),tabs:[...document.querySelectorAll('.inspector-tabs button')].map(rect),
          ready:document.querySelectorAll('.preset-preview[data-preview-ready=true]').length,
          layers:document.querySelectorAll('[data-clip-id]').length};
      })()`);
      assert.equal(layout.documentWidth,width,"Interface overflows horizontally");
      assert.equal(layout.workspace.width,width,"Workspace does not fill the window");
      assert.match(layout.font,/Inter/); assert.equal(layout.layers,4,"Catalogue previews must not add project media/clips");
      assert.ok(layout.inspectorType.every(size=>size>=12),"Inspector labels must remain readable");
      assert.ok(layout.toolbar.right<=width&&layout.footer.bottom<=height,"Timeline chrome is clipped");
      assert.ok(layout.guide.bottom<=layout.nav.bottom+.5,"Tool navigation must fit without scrolling");
      assert.ok(layout.canvas.width>100&&layout.canvas.height>100,"Preview is too small or missing");
      assert.ok(layout.canvas.width<=layout.stage.width+.5&&layout.canvas.height<=layout.stage.height+.5,"Preview clipped by its panel");
      for (const control of layout.controls) assert.ok(control.rect.left>=layout.inspector.left-.5&&control.rect.right<=layout.inspector.right+.5,`Inspector overflow at ${width}: ${control.label}`);
      for (const tab of layout.tabs) assert.ok(tab.right<=layout.inspector.right+.5,"Inspector tabs overflow");
      assert.ok(layout.ready>=2,"Real rendered previews are missing");
      assert.ok(layout.cards.filter(card=>card.top>=layout.library.top-.5&&card.bottom<=layout.library.bottom+.5).length>=2,
        `The first row of effect cards must be visible without scrolling at ${width}×${height}`);
      process.stdout.write(JSON.stringify({size:[width,height],preview:[layout.canvas.width,layout.canvas.height],ready:layout.ready})+"\n");
    }
    win.setSize(1480,920); await waitFor(() => run('innerWidth===1480&&innerHeight===920'));
    await screenshot("studio-effects");
    await category("Light");
    const light = await run('document.querySelectorAll(".effect-card").length');
    assert.ok(light>3&&light<34,"Effect category filtering failed");
    await category("All"); await search("Swirl");
    await waitFor(() => run('document.querySelectorAll(".effect-card").length===1'));
    assert.equal(await run('document.querySelector(".effect-card strong").textContent'),"Swirl");
    await search("definitely-not-an-effect");
    await waitFor(() => run('Boolean(document.querySelector(".catalogue-empty"))'));
    await run('document.querySelector(".catalogue-empty button").click()');
    await waitFor(() => run('document.querySelectorAll(".effect-card").length===34'));
    await chooseLibrary("Transitions"); await selectClip("mask-subject");
    await waitFor(() => run('document.querySelectorAll(".transition-card").length===45'));
    await category("Movement");
    await waitFor(() => run('document.querySelectorAll(".transition-card").length>5'));
    await run(`[...document.querySelectorAll('.transition-card')].find(button=>button.querySelector('strong').textContent==='Cross zoom').click()`);
    await waitFor(() => run('Boolean(document.querySelector(".transition-card.active")?.textContent.includes("Cross zoom"))'));
    await run(`[...document.querySelectorAll('.inspector-tabs button')].find(button=>button.textContent==='Basic').click()`);
    await waitFor(() => run('Boolean([...document.querySelectorAll(".inspector select option:checked")].find(option=>option.textContent==="Cross zoom"))'));
    await waitFor(() => run('document.querySelectorAll(".preset-preview[data-preview-ready=true]").length>=2'));
    await screenshot("studio-transitions");
    // Hidden native windows can stop producing compositor frames after capturePage.
    // Drive paint frames in an isolated offscreen UI for animation assertions; it
    // deliberately has no native preload/IPC and cannot impersonate the main window.
    const animationWindow = new BrowserWindow({ show: false, width: 1480, height: 920,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false,
        backgroundThrottling: false, offscreen: true } });
    contents = animationWindow.webContents; contents.setFrameRate(30);
    contents.on("console-message", (event) => { if (event.level === "error") errors.push(event.message); });
    await animationWindow.loadFile(path.resolve("dist-desktop/index.html"));
    await waitFor(() => run('Boolean(document.querySelector(".timeline")&&!document.querySelector(".loading-project"))'));
    await chooseLibrary("Transitions"); await category("Movement");
    await waitFor(() => run('document.querySelectorAll(".preset-preview[data-preview-ready=true]").length>=2'));
    // Real hover preview changes frame pixels; only the active preset animates.
    const animate = await run(`(async()=>{const card=[...document.querySelectorAll('.transition-card')].find(button=>button.querySelector('strong').textContent==='Slide left');
      card.scrollIntoView({block:'nearest'}); await new Promise(resolve=>setTimeout(resolve,250));
      card.dispatchEvent(new FocusEvent('focusin',{bubbles:true}));
      await new Promise(resolve=>setTimeout(resolve,250));
      const canvas=card.querySelector('canvas'), pixels=()=>canvas.getContext('2d').getImageData(0,0,192,108).data;
      const first=pixels(); let ticks=0,frame=0;const count=()=>{ticks++;frame=requestAnimationFrame(count);}; frame=requestAnimationFrame(count);
      await new Promise(resolve=>setTimeout(resolve,700)); const second=pixels(); cancelAnimationFrame(frame);
      let changed=0;for(let i=0;i<first.length;i++)if(first[i]!==second[i])changed++;
      const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
      const label=card.querySelector('.preset-preview-play').textContent, ready=card.querySelector('.preset-preview').dataset.previewReady;
      card.dispatchEvent(new FocusEvent('focusout',{bubbles:true})); return {changed,ticks,reduced,label,ready,hidden:document.hidden};})()`);
    process.stdout.write(JSON.stringify({animation:animate})+"\n");
    assert.equal(animate.ready,"true","Focused preview did not finish loading");
    if (!animate.reduced) assert.ok(animate.changed>100,"Focused preview did not animate actual frames");
    await chooseLibrary("Effects"); await search("Light leak");
    await waitFor(() => run('document.querySelectorAll(".effect-card").length===1&&Boolean(document.querySelector(".preset-preview[data-preview-ready=true]"))'));
    const longPreview = await run(`(async()=>{const card=document.querySelector('.effect-card');card.dispatchEvent(new FocusEvent('focusin',{bubbles:true}));
      await new Promise(resolve=>setTimeout(resolve,3600));const data=card.querySelector('canvas').getContext('2d').getImageData(0,0,192,108).data;
      const colors=new Set();for(let i=0;i<data.length;i+=16)colors.add(data[i]+','+data[i+1]+','+data[i+2]);
      card.dispatchEvent(new FocusEvent('focusout',{bubbles:true}));return colors.size;})()`);
    assert.ok(longPreview>30,"A long effect preview went blank after its synthetic source ended");
    assert.deepEqual(errors,[],"Production renderer logged errors");
    process.stdout.write("CUTLINE_STUDIO_DESIGN_LAYOUT_READY\n");
    clearTimeout(timeout); app.exit(0);
  } catch (error) {
    await mkdir(path.resolve("work"), { recursive: true });
    await writeFile(path.resolve("work/design-layout-failure.png"), (await contents.capturePage()).toPNG()).catch(()=>{});
    process.stderr.write(String(error.stack??error)+"\n"); clearTimeout(timeout); app.exit(1);
  }
});
