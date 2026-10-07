// Production desktop layout check. Its generated media and project live only in an isolated profile.
const assert = require("node:assert/strict");
const path = require("node:path");
const { mkdir, writeFile } = require("node:fs/promises");
const { zipSync, strToU8 } = require("fflate");
const { app, BrowserWindow } = require("electron");

process.env.CUTLINE_LAYOUT_TEST = "1";
process.env.CUTLINE_TEST_PROFILE ??= path.resolve("work/masking-layout-profile-050");
require(process.env.CUTLINE_TEST_APP_MAIN || "../electron/main.cjs");

function waitFor(condition, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = async () => {
      try {
        const result = await condition();
        if (result) return resolve(result);
        if (Date.now() >= deadline) throw new Error("Desktop masking check timed out");
        setTimeout(check, 40);
      } catch (error) { reject(error); }
    };
    void check();
  });
}

function rhythmWav() {
  const rate = 16000, duration = 16, count = rate * duration;
  const output = Buffer.alloc(44 + count * 2);
  output.write("RIFF", 0); output.writeUInt32LE(output.length - 8, 4);
  output.write("WAVEfmt ", 8); output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20); output.writeUInt16LE(1, 22);
  output.writeUInt32LE(rate, 24); output.writeUInt32LE(rate * 2, 28);
  output.writeUInt16LE(2, 32); output.writeUInt16LE(16, 34);
  output.write("data", 36); output.writeUInt32LE(count * 2, 40);
  for (let i = 0; i < count; i++) {
    const time = i / rate, local = time % 0.5;
    const value = Math.sin(time * Math.PI * 2 * (80 + 160 * Math.exp(-local * 30))) * Math.exp(-local * 24) * 0.7;
    output.writeInt16LE(Math.round(value * 32767), 44 + i * 2);
  }
  return output;
}

async function importSyntheticProject(contents, catalogue = false) {
  const images = await contents.executeJavaScript(`(() => {
    const create = (warm) => {
      const canvas = document.createElement('canvas'); canvas.width = 1920; canvas.height = 1080;
      const ctx = canvas.getContext('2d');
      const sky = ctx.createLinearGradient(0, 0, 0, 1080);
      (warm ? [[0,'#f6ba87'],[.46,'#e7828d'],[1,'#5b507f']] : [[0,'#141932'],[.53,'#39365b'],[1,'#698196']])
        .forEach(([at,color]) => sky.addColorStop(at,color));
      ctx.fillStyle = sky; ctx.fillRect(0, 0, 1920, 1080);
      ctx.fillStyle = warm ? '#fff0d2' : '#e1dfe9'; ctx.beginPath(); ctx.arc(1120, 360, 125, 0, Math.PI * 2); ctx.fill();
      const ranges = [
        {fill:warm?'#aa6381':'#5d668a',points:[[0,655],[245,575],[370,620],[590,430],[805,585],[1030,490],[1350,650],[1580,470],[1780,590],[1920,560]]},
        {fill:warm?'#715878':'#3b4c6f',points:[[0,720],[205,800],[465,650],[710,815],[990,690],[1240,835],[1485,685],[1730,800],[1920,760]]},
        {fill:warm?'#343953':'#202d49',points:[[0,920],[330,790],[545,905],[835,830],[1130,950],[1435,820],[1610,940],[1920,850]]}
      ];
      for(const range of ranges) { ctx.fillStyle=range.fill; ctx.beginPath(); ctx.moveTo(0,1080);
        range.points.forEach(([x,y])=>ctx.lineTo(x,y)); ctx.lineTo(1920,1080); ctx.closePath(); ctx.fill(); }
      const thumb = document.createElement('canvas'); thumb.width = 480; thumb.height = 270;
      thumb.getContext('2d').drawImage(canvas,0,0,480,270);
      return { image:canvas.toDataURL('image/png').split(',')[1], thumbnail:thumb.toDataURL('image/png') };
    };
    return [create(false),create(true)];
  })()`);
  const peaks = Array.from({ length: 4096 }, (_, i) => 0.045 + 0.84 * Math.exp(-(i * 16 / 4096 % .5) * 24));
  const assets = [
    { id: "scene", name: "Blue hour landscape.png", kind: "image", duration: 16, sizeLabel: "Local image", theme: "image", width: 1920, height: 1080, thumbnail: images[0].thumbnail },
    { id: "iris", name: "Golden hour landscape.png", kind: "image", duration: 16, sizeLabel: "Local image", theme: "image", width: 1920, height: 1080, thumbnail: images[1].thumbnail },
    { id: "rhythm", name: "Ambient rhythm.wav", kind: "audio", duration: 16, sizeLabel: "16 seconds", theme: "audio", waveform: peaks.map((peak) => peak * .7), waveformPeaks: peaks },
  ];
  const project = {
    version: 3, id: "masking-layout-sample", name: "COLOR STORIES / A study in masks", ratio: "16:9", fps: 30, background: "#0b1324", layerCount: 4,
    mutedTracks: [], hiddenTracks: [], lockedTracks: ["layer:1"], assets,
    markers: [2,4,6,8,10,12].map((time,index) => ({ id:`cue-${index}`, kind:index===4 ? "moment" : "beat", time })),
    clips: [
      { id: "mask-base", assetId: "scene", kind: "video", label: "Blue hour · Background", start: 0, track: 1, sourceStart: 0, sourceEnd: 16, speed: 1, fit: "contain", volume: 0 },
      { id: "mask-subject", assetId: "iris", kind: "video", label: "Golden hour · Ellipse mask", start: 0, track: 2, sourceStart: 0, sourceEnd: 16, speed: 1, fit: "contain", volume: 0,
        maskShape:"Ellipse", maskSpace:"content", maskX:.5,maskY:.44,maskWidth:.53,maskHeight:.74,maskRotation:0,maskFeather:.015,maskInvert:false },
      { id: "mask-sound", assetId: "rhythm", kind: "audio", label: "Ambient rhythm", start: 0, track: 0, sourceStart: 0, sourceEnd: 16, speed: 1, volume: .6, fadeIn:.4,fadeOut:1 },
    ],
    texts: [
      { id: "mask-title", text:"Beyond the frame.", label:"Beyond the frame.", start:0, duration:16, track:3, kind:"text", x:.5,y:.87,fontSize:76,fontFamily:"Manrope Variable",fontWeight:700,color:"#fff7f0",shadowBlur:5,background:false },
    ],
  };
  if (catalogue) {
    project.name = "COLOR STORIES / The quiet between";
    project.layerCount = 3; project.lockedTracks = [];
    project.clips[0].sourceEnd = 8;
    project.clips[1] = { ...project.clips[1], label: "Golden hour", track: 1, start: 8, sourceEnd: 8,
      maskShape: "None", transition: "Dissolve", transitionDuration: 1 };
    project.texts[0] = { ...project.texts[0], track: 2, text: "The quiet between.", label: "The quiet between.",
      y: .76, fontFamily: "Playfair Display Variable", fontSize: 90, fontWeight: 500 };
  }
  const backup = zipSync({
    "project.json": strToU8(JSON.stringify(project)),
    "media/scene": new Uint8Array(Buffer.from(images[0].image, "base64")),
    "media/iris": new Uint8Array(Buffer.from(images[1].image, "base64")),
    "media/rhythm": new Uint8Array(rhythmWav()),
  }, { level: 0 });
  const base64 = Buffer.from(backup).toString("base64");
  await contents.executeJavaScript(`(() => {
    const bytes = Uint8Array.from(atob(${JSON.stringify(base64)}),character=>character.charCodeAt(0));
    const file = new File([bytes], 'Masking showcase.cutline', {type:'application/zip'});
    const transfer = new DataTransfer(); transfer.items.add(file);
    const input = document.querySelector('input[accept=".cutline,.zip"]');
    input.files = transfer.files; input.dispatchEvent(new Event('change',{bubbles:true}));
  })()`);
  await waitFor(() => contents.executeJavaScript('Boolean(document.querySelector(\'[data-clip-id="mask-subject"]\') && document.querySelector(".toast")?.textContent.includes("Project restored with its media.") && !document.querySelector(".busy-indicator") && !document.querySelector(".preview-loading"))'));
}

module.exports = { waitFor, importSyntheticProject };

if (require.main === module) app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0];
  const errors = [];
  win.webContents.on("console-message", (event) => { if (event.level === "error") errors.push(event.message); });
  const timeout = setTimeout(() => { process.stderr.write("Desktop masking layout timed out\n"); app.exit(1); }, 90000);
  try {
    const contents = win.webContents;
    await waitFor(() => contents.executeJavaScript('Boolean(document.querySelector(".timeline") && !document.querySelector(".loading-project"))'));
    await importSyntheticProject(contents);
    await contents.executeJavaScript(`document.querySelector('[data-clip-id="mask-subject"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`);
    await waitFor(() => contents.executeJavaScript('[...document.querySelectorAll(".inspector-tabs button")].some(button=>button.textContent==="Mask")'));
    await contents.executeJavaScript(`[...document.querySelectorAll('.inspector-tabs button')].find(button=>button.textContent==='Mask').click()`);
    await waitFor(() => contents.executeJavaScript('Boolean(document.querySelector(".mask-presets"))'));
    await contents.executeJavaScript(`document.querySelector('[aria-label="Edit mask"]').click()`);
    await waitFor(() => contents.executeJavaScript('Boolean(document.querySelector(".mask-overlay"))'));
    for (const [width, height] of [[1480,920],[1100,700]]) {
      win.setSize(width,height);
      await waitFor(() => contents.executeJavaScript(`innerWidth===${width} && innerHeight===${height}`));
      await contents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      const layout = await contents.executeJavaScript(`(() => {
        const rect = element=>{const r=element.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
        const inspector = document.querySelector('.inspector');
        return { viewport:[innerWidth,innerHeight], documentWidth:document.documentElement.scrollWidth,
          workspace:rect(document.querySelector('.editing-workspace')), inspector:rect(inspector),
          canvas:rect(document.querySelector('.canvas-wrap')), stage:rect(document.querySelector('.preview-stage')),
          controls:[...inspector.querySelectorAll('button,input,select')].map(el=>({label:el.getAttribute('aria-label')||el.textContent,rect:rect(el)})),
          headers:[...document.querySelectorAll('.track-header')].map(el=>({rect:rect(el),label:rect(el.querySelector(':scope > span')),buttons:[...el.querySelectorAll('button')].map(rect)})),
          maskButtons:[...document.querySelectorAll('.mask-overlay button')].map(rect),
          maskEnabled:document.querySelector('[aria-label="Edit mask"]').getAttribute('aria-pressed'),
          shapes:document.querySelectorAll('.mask-presets button').length,
        };
      })()`);
      assert.equal(layout.documentWidth,width,"Desktop interface overflowed horizontally");
      assert.equal(layout.workspace.width,width,"Workspace does not fill the window");
      assert.equal(layout.maskEnabled,"true","Canvas mask editing was not enabled");
      assert.equal(layout.shapes,7,"Mask shape controls are missing");
      assert.ok(layout.canvas.width>0 && layout.canvas.height>0,"Preview disappeared");
      assert.ok(layout.canvas.width<=layout.stage.width+.5 && layout.canvas.height<=layout.stage.height+.5,"Preview is clipped by its panel");
      for(const control of layout.controls) {
        assert.ok(control.rect.left>=layout.inspector.left-.5 && control.rect.right<=layout.inspector.right+.5,
          `Inspector control overflows at ${width}×${height}: ${control.label}`);
      }
      for(const header of layout.headers) {
        assert.equal(header.buttons.length,3,"Layer needs lock, hide and mute buttons");
        assert.ok(header.label.right<=header.buttons[0].left+.5,"Layer label overlaps its controls");
        for(const button of header.buttons) assert.ok(button.left>=header.rect.left-.5 && button.right<=header.rect.right+.5,
          `Layer buttons overflow at ${width}×${height}`);
      }
      for(const button of layout.maskButtons) assert.ok(button.width>0 && button.height>0,"Mask handle disappeared");
      process.stdout.write(JSON.stringify({size:layout.viewport,inspectorWidth:layout.inspector.width,preview:[layout.canvas.width,layout.canvas.height],shapePresets:layout.shapes,headers:layout.headers.length})+"\n");
    }
    win.setSize(1480,920);
    await waitFor(() => contents.executeJavaScript('innerWidth===1480 && innerHeight===920 && !document.querySelector(".toast")'));
    await contents.executeJavaScript('document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))');
    assert.deepEqual(errors,[],"Production renderer logged errors");
    await mkdir(path.resolve("docs/screenshots"),{recursive:true});
    await writeFile(path.resolve("docs/screenshots/masking.png"),(await contents.capturePage()).toPNG());
    process.stdout.write("CUTLINE_MASKING_LAYOUT_AND_SCREENSHOT_READY\n");
    clearTimeout(timeout); app.exit(0);
  } catch(error) {
    await mkdir(path.resolve("work"),{recursive:true});
    await writeFile(path.resolve("work/masking-layout-failure.png"),(await win.webContents.capturePage()).toPNG()).catch(()=>{});
    process.stderr.write(String(error.stack??error)+"\n");
    clearTimeout(timeout); app.exit(1);
  }
});
