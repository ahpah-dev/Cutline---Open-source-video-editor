// Real production UI, real model inference, isolated test project/profile only.
const assert = require("node:assert/strict");
const path = require("node:path");
const { mkdir, writeFile } = require("node:fs/promises");
const { zipSync, strToU8 } = require("fflate");
process.env.CUTLINE_TEST_PROFILE = path.resolve("work/color-detection-profile-070");
const { app, BrowserWindow, session } = require("electron");
const { waitFor, importSyntheticProject } = require("./masking-desktop-layout.cjs");

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0], contents = win.webContents;
  const run = (source) => contents.executeJavaScript(source).catch((error) => { throw new Error(`${error.message}\nScript: ${source.slice(0,700)}`); }), errors = [], requests = [];
  contents.on("console-message", (event) => { if (event.level === "error") errors.push(event.message); });
  const timeout = setTimeout(() => { process.stderr.write("Color/detection production test timed out\n"); app.exit(1); }, 330000);
  const clickText = (selector, text) => run(`[...document.querySelectorAll(${JSON.stringify(selector)})].find(button=>button.textContent.trim()===${JSON.stringify(text)}).click()`);
  const setValue = (selector, value) => run(`(() => { const input=document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  const saveShot = async (name) => {
    await waitFor(() => run('!document.querySelector(".toast")'));
    await run('document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))');
    await mkdir("docs/screenshots", { recursive: true });
    const shot = await contents.capturePage(undefined, { stayHidden: true, stayAwake: true }); await writeFile(path.resolve(`docs/screenshots/${name}.png`), shot.toPNG());
  };
  try {
    await waitFor(() => run('Boolean(document.querySelector(".timeline")&&!document.querySelector(".loading-project"))'));
    await importSyntheticProject(contents, true);
    await run(`document.querySelector('[data-clip-id="mask-base"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`);
    await clickText(".inspector-tabs button", "Color");
    await waitFor(() => run('Boolean(document.querySelector(".grading-controls"))'));
    await setValue('[aria-label="Exposure value"]', .7);
    await run(`document.querySelector('[aria-label="Add exposure keyframe"]').click()`);
    await waitFor(() => run(`Boolean(document.querySelector('[aria-label="Remove exposure keyframe"]'))`));
    await setValue('[aria-label="Exposure value"]', 1.1);
    await setValue('[aria-label="Exposure value"]', .3);
    await clickText(".grade-pages button", "Curves");
    await setValue('[aria-label="Curve output"]', 7);
    assert.equal(await run(`document.querySelector('[aria-label="Curve output"]').value`), "7");
    await run(`(() => {const svg=document.querySelector('.curve-graph'),rect=svg.getBoundingClientRect();svg.setPointerCapture=()=>{};
      svg.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,pointerId:98,clientX:rect.left+rect.width*.46,clientY:rect.top+rect.height*.42}));
      svg.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,button:0,pointerId:98}));})()`);
    await waitFor(() => run(`document.querySelectorAll('.curve-graph circle').length===3`));
    for (const [width, height] of [[1100,700],[1480,920],[1920,1080]]) {
      win.setSize(width, height); await waitFor(() => run(`innerWidth===${width}`));
      const layout = await run(`(() => {const inspector=document.querySelector('.inspector'), r=inspector.getBoundingClientRect();
        return {width:document.documentElement.scrollWidth, controls:[...inspector.querySelectorAll('button,input,select,svg.curve-graph')].filter(el=>el.getBoundingClientRect().width>0).map(el=>{const c=el.getBoundingClientRect();return {label:el.getAttribute('aria-label')||el.textContent,left:c.left,right:c.right};}), left:r.left,right:r.right};})()`);
      assert.equal(layout.width, width, "Color lab overflows document");
      for (const control of layout.controls) assert.ok(control.left >= layout.left - 1 && control.right <= layout.right + 1, `Color lab clips ${control.label}`);
      process.stdout.write(JSON.stringify({ colorLayout: [width,height] }) + "\n");
    }
    win.setSize(1920,1080);
    await waitFor(() => run('innerWidth===1920&&innerHeight===1080'));
    await run(`document.querySelector('.grade-pages').scrollIntoView({block:'start'})`);
    await saveShot("color-grading");
    await clickText(".grade-pages button", "Wheels");
    await run(`document.querySelector('[aria-label="Shadows color wheel"]').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true}))`);
    await waitFor(() => run(`document.querySelector('[aria-label="Shadows color wheel"]').getAttribute('aria-valuenow')==='2'`));
    await run(`document.querySelector('.inspector-scroll')?.scrollTo(0,0)`);
    await saveShot("color-wheels");
    await clickText(".inspector-tabs button", "Mask");
    await run(`[...document.querySelectorAll('.toggle-field')].find(label=>label.textContent.includes('Remove a color')).querySelector('.switch').click()`);
    await waitFor(() => run('Boolean([...document.querySelectorAll(".color-field")].find(label=>label.textContent.includes("Key color")))'));
    await run(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true}))`);
    await waitFor(() => run('![...document.querySelectorAll(".color-field")].find(label=>label.textContent.includes("Key color"))'));
    if (process.env.CUTLINE_UI_ONLY === "1") { assert.equal(errors.length,0,errors.join("\n")); clearTimeout(timeout); process.stdout.write("CUTLINE_COLOR_UI_READY\n"); app.exit(0); return; }

    // The official Transformers.js example photo is fetched only for this test;
    // imported as a local embedded asset, never added to the user's project.
    const response = await fetch("https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/cats.jpg");
    assert.ok(response.ok, "Could not load official object-detector fixture"); const image = new Uint8Array(await response.arrayBuffer());
    const project = { version:3, id:"object-production", name:"Object detection verification", ratio:"16:9", fps:30,
      background:"#10211c", layerCount:3, markers:[], mutedTracks:[],hiddenTracks:[],lockedTracks:[],texts:[],
      assets:[{id:"cats",name:"Object detection test.jpg",kind:"image",duration:5,width:640,height:480,theme:"image",sizeLabel:"Test only"}],
      clips:[{id:"detect-clip",assetId:"cats",kind:"video",label:"Local source · object analysis",start:0,track:0,sourceStart:0,sourceEnd:5,speed:1,fit:"contain"}] };
    const backup=zipSync({"project.json":strToU8(JSON.stringify(project)),"media/cats":image},{level:0}), base64=Buffer.from(backup).toString("base64");
    await run(`(() => {const bytes=Uint8Array.from(atob(${JSON.stringify(base64)}),c=>c.charCodeAt(0));const transfer=new DataTransfer();transfer.items.add(new File([bytes],'Objects.cutline',{type:'application/zip'}));const input=document.querySelector('input[accept=".cutline,.zip"]');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await waitFor(() => run('Boolean(document.querySelector("[data-clip-id=detect-clip]")&&!document.querySelector(".busy-indicator")&&!document.querySelector(".preview-loading"))'));
    await run(`document.querySelector('[data-clip-id="detect-clip"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`);
    await clickText(".inspector-tabs button", "Mask");
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => { requests.push(details.url); callback({cancel:false}); });
    await clickText(".object-detection button", "Detect objects");
    assert.ok(await run('Boolean(document.querySelector(".detector-consent"))'), "No explicit model download prompt");
    await clickText(".detector-consent button", "Download & detect");
    await waitFor(async () => {
      const state=await run('({error:document.querySelector(".detection-error")?.textContent,ready:Boolean(document.querySelector(".detection-image")),status:document.querySelector(".detection-progress")?.textContent})');
      if(state.error) throw new Error(state.error); return state.ready;
    },240000);
    const objects=await run('[...document.querySelectorAll(".detected-objects button")].map(el=>el.textContent)');
    assert.ok(objects.some((label)=>label.includes("cat")), "Real detector did not find a cat in official example photo");
    process.stdout.write(JSON.stringify({realObjects:objects,modelRequests:requests.filter(url=>url.includes('yolos-tiny')).length})+"\n");
    await clickText(".detection-actions button","Mask object");
    await waitFor(() => run('document.querySelector(".mask-presets button.active")?.textContent.trim()==="Rectangle"'));
    await run(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true}))`);
    await waitFor(() => run('document.querySelector(".mask-presets button.active")?.textContent.trim()==="None"'));
    await run(`[...document.querySelectorAll('.detected-objects button')].find(button=>button.textContent.includes('cat')).click();document.querySelector('.object-detection').scrollIntoView({block:'start'})`);
    await saveShot("object-detection");
    // Cached second run deliberately blocks every external model request.
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({cancel:/^https?:/.test(details.url)}));
    await clickText(".inspector-tabs button","Color"); // Unmount terminates the warm worker.
    await clickText(".inspector-tabs button","Mask");
    await clickText(".object-detection button","Detect objects");
    await clickText(".detector-consent button","Download & detect");
    await waitFor(async () => {const state=await run('({error:document.querySelector(".detection-error")?.textContent,busy:Boolean(document.querySelector(".detection-progress")),status:[...document.querySelectorAll(".object-detection [role=status]")].map(e=>e.textContent).join()})');if(state.error) throw new Error(state.error);return !state.busy&&state.status.includes('objects found');},90000);
    assert.equal(errors.length,0,errors.join("\n"));
    await mkdir("work",{recursive:true}); await writeFile("work/color-detection-results.json",JSON.stringify({objects,errors,networkCalls:requests.filter(url=>url.includes('huggingface')).length,offline:true},null,2));
    clearTimeout(timeout); process.stdout.write("CUTLINE_COLOR_AND_OBJECT_DETECTION_READY\n"); app.exit(0);
  } catch(error) {
    await mkdir("work",{recursive:true}); await contents.capturePage().then(image=>writeFile("work/color-detection-failure.png",image.toPNG())).catch(()=>{});
    process.stderr.write(String(error.stack??error)+"\n"+errors.join("\n"));clearTimeout(timeout);app.exit(1);
  }
});
