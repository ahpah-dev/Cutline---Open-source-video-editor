import { animatedItem, makeClip, makeText, newProject, setPropertyKeyframe, type Asset, type Clip } from "../app/editor/model";
import { Renderer } from "../app/editor/renderer";
import { exportFormats, exportProject } from "../app/editor/media";
import { TRANSITIONS } from "../app/editor/presets";
import { MASK_SHAPES, maskGeometry, type VisualCompositing } from "../app/editor/visualCompositing";

type Check = (name: string, run: () => unknown) => Promise<void>;
type Assert = (condition: unknown, message: string) => void;
const canvas = () => { const c = document.createElement("canvas"); c.width = 320; c.height = 180; c.getContext("2d", { willReadFrequently: true }); return c; };
const pixel = (c: HTMLCanvasElement, x: number, y: number) => [...c.getContext("2d")!.getImageData(x, y, 1, 1).data];
const hash = (c: HTMLCanvasElement) => { const data = c.getContext("2d")!.getImageData(0,0,c.width,c.height).data; let n = 2166136261; for (const value of data) n = Math.imul(n ^ value, 16777619); return n >>> 0; };
const fixture = async (paint: (ctx: CanvasRenderingContext2D) => void) => {
  const source = canvas(); paint(source.getContext("2d")!);
  const image = new Image(); image.src = source.toDataURL(); await image.decode();
  const asset: Asset = { id: "visual", name: "visual.png", kind: "image", width: 320, height: 180, duration: 4, theme: "image", sizeLabel: "1 KB" };
  const clip = makeClip(asset); const project = newProject(); project.assets = [asset]; project.clips = [clip]; project.background = "#000000";
  return { image, project, clip, sources: new Map([[clip.id, image]]) };
};

export async function runVisualCompositingTests(check: Check, assert: Assert) {
  await check("Encoded masked video retains the mask rather than exporting the unmasked source", async () => {
    const f = await fixture((ctx) => { ctx.fillStyle = "white"; ctx.fillRect(0, 0, 320, 180); });
    f.project.assets[0].url = f.image.src;
    f.project.clips[0] = { ...f.clip, sourceEnd: 2, maskShape: "Ellipse", maskWidth: .5, maskHeight: .5 };
    const format = exportFormats()[0]; assert(format, "No supported video encoder");
    const blob = await exportProject(f.project, { resolution: 720, fps: 30, mime: format.mime, signal: new AbortController().signal, onProgress() {} });
    const url = URL.createObjectURL(blob), video = document.createElement("video"); video.muted = true;
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Masked export decoder timed out")), 10000);
        video.onloadeddata = () => { clearTimeout(timer); resolve(); };
        video.onerror = () => { clearTimeout(timer); reject(new Error("Masked export could not be decoded")); };
        video.src = url; video.load();
      });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Masked export seek timed out")), 10000);
        video.onseeked = () => { clearTimeout(timer); resolve(); };
        video.currentTime = .35;
      });
      const output = canvas(); output.getContext("2d")!.drawImage(video, 0, 0, 320, 180);
      const center = pixel(output, 160, 90), outside = pixel(output, 10, 10);
      assert(center[0] > 220 && outside[0] < 20, `Encoded video did not retain the ellipse mask: center=${center}, outside=${outside}`);
    } finally { video.removeAttribute("src"); video.load(); URL.revokeObjectURL(url); }
  });
  await check("Every mask shape clips real pixels; invert/feather and reset are non-destructive", async () => {
    const f = await fixture((ctx) => {ctx.fillStyle = "white"; ctx.fillRect(0,0,320,180);});
    const c = canvas(), renderer = new Renderer(); renderer.draw(c,f.project,0,f.sources); const baseline = hash(c);
    const hashes = new Set<number>();
    for (const shape of MASK_SHAPES.filter((shape) => shape !== "None")) {
      f.project.clips[0] = { ...f.clip, maskShape: shape, maskWidth: 0.55, maskHeight: 0.55 };
      renderer.draw(c,f.project,0,f.sources); hashes.add(hash(c)); assert(hash(c) !== baseline, shape + " did not mask pixels");
    }
    assert(hashes.size === 6, "Mask shape outputs should be distinct");
    f.project.clips[0] = { ...f.clip, maskShape: "Rectangle", maskWidth: 0.5, maskHeight: 0.5, maskFeather: 0.04 };
    renderer.draw(c,f.project,0,f.sources);
    const edge = pixel(c,78,90)[0]; assert(edge > 0 && edge < 220, "Feather should blend through the crop edge");
    f.project.clips[0].maskFeather = 0; f.project.clips[0].maskInvert = true;
    renderer.draw(c,f.project,0,f.sources); assert(pixel(c,160,90)[0] < 5 && pixel(c,10,10)[0] > 250, "Invert must reveal the opposite region");
    for (const mask of [{ maskShape: "Rectangle", maskWidth: 2, maskHeight: 2 }, { maskShape: "Linear", maskY: -1 }, { maskShape: "Mirror", maskHeight: 3 }] as VisualCompositing[]) {
      f.project.clips[0] = { ...f.clip, ...mask, maskFeather: 0.1 };
      renderer.draw(c,f.project,0,f.sources);
      assert(pixel(c,0,0)[0]>250 && pixel(c,319,179)[0]>250,"Feather must not invent an output-frame edge for " + mask.maskShape);
    }
    f.project.clips[0] = f.clip; renderer.draw(c,f.project,0,f.sources); assert(hash(c) === baseline, "Reset should restore source pixels exactly");
  });
  await check("Animated masks follow transformed content and shared preview/export frames", async () => {
    const f = await fixture((ctx) => {ctx.fillStyle = "#ff0000"; ctx.fillRect(0,0,320,180);});
    let clip: Clip = { ...f.clip, scale: 0.6, rotation: 30, x: 0.1, maskShape: "Ellipse", maskWidth: 0.4, maskHeight: 0.7, flipX: true };
    clip = setPropertyKeyframe(clip,"maskX",0,0.2); clip = setPropertyKeyframe(clip,"maskX",2,0.8);
    f.project.clips[0] = clip;
    const c=canvas(), exportFrame=canvas(), r=new Renderer();
    r.draw(c,f.project,1,f.sources); const bounds = r.bounds[0], frame = maskGeometry(animatedItem(clip,1),{...bounds,flipX:clip.flipX,flipY:clip.flipY},320,180);
    assert(pixel(c,Math.round(frame.x),Math.round(frame.y))[0] > 200,"Mask should track rotated/scaled clip center");
    new Renderer().draw(exportFrame,f.project,1,f.sources); assert(hash(c) === hash(exportFrame),"Export and preview must match");
    r.draw(c,f.project,0,f.sources); const first=hash(c); r.draw(c,f.project,2,f.sources); assert(hash(c)!==first,"Mask property keyframes must animate rendered pixels");
  });
  await check("Chroma key removes original key colors before grading and retains solid foreground", async () => {
    const f = await fixture((ctx) => {ctx.fillStyle="#00ff00";ctx.fillRect(0,0,320,180);ctx.fillStyle="#ff0000";ctx.fillRect(160,0,160,180);});
    f.project.background="#0000ff"; f.project.clips[0] = { ...f.clip, chromaKey:true, chromaTolerance:0.1,chromaSoftness:0.05,brightness:60 };
    const c=canvas(), r=new Renderer(); r.draw(c,f.project,0,f.sources);
    assert(pixel(c,50,90)[2]>245 && pixel(c,50,90)[1]<5,"Green key must reveal lower blue even after grading");
    assert(pixel(c,250,90)[0]>130 && pixel(c,250,90)[2]<5,"Solid red foreground should retain opacity and grading");
    const rendered=hash(c); const fresh=canvas(); new Renderer().draw(fresh,f.project,0,f.sources); assert(hash(fresh)===rendered,"Chroma export/preview should agree");
  });
  await check("Blend modes combine actual upper/lower pixels and keep the final canvas opaque", async () => {
    const f = await fixture((ctx) => {ctx.fillStyle="#ff0000";ctx.fillRect(0,0,320,180);});f.project.background="#808080";
    const c=canvas(),r=new Renderer(); f.project.clips[0]={...f.clip,blendMode:"Multiply"};r.draw(c,f.project,0,f.sources);
    const multiply=pixel(c,160,90);assert(multiply[0]>=126&&multiply[0]<=130&&multiply[1]<3&&multiply[3]===255,"Multiply should darken against lower gray");
    f.project.clips[0].blendMode="Screen";r.draw(c,f.project,0,f.sources);const screen=pixel(c,160,90);
    assert(screen[0]>250&&screen[1]>=126&&screen[1]<=130&&screen[3]===255,"Screen should lighten against lower gray");
    f.project.texts=[makeText(0,{text:"BLEND",fontSize:300,shadowBlur:0,shadowOffset:0,blendMode:"Difference"})];
    r.draw(c,f.project,0,f.sources);assert(hash(c)!==hash((()=>{const plain=canvas();r.draw(plain,{...f.project,texts:[]},0,f.sources);return plain;})()),"Text blend must affect output");
  });
  await check("Masks apply independently to both sides of a true transition", async () => {
    const first = await fixture((ctx)=>{ctx.fillStyle="#ff0000";ctx.fillRect(0,0,320,180);});
    const second = await fixture((ctx)=>{ctx.fillStyle="#0000ff";ctx.fillRect(0,0,320,180);});
    const outgoing={...first.clip,sourceEnd:2,maskShape:"Ellipse" as const,maskWidth:.7,maskHeight:.7};
    const incoming={...second.clip,id:"incoming",assetId:"second",start:2,sourceEnd:2,transition:"Dissolve" as const,transitionDuration:1,maskShape:"Ellipse" as const,maskWidth:.7,maskHeight:.7};
    first.project.assets.push({...second.project.assets[0],id:"second"});first.project.clips=[outgoing,incoming];first.sources.set(incoming.id,second.image);
    const c=canvas();new Renderer().draw(c,first.project,2,first.sources);const center=pixel(c,160,90),outside=pixel(c,10,10);
    assert(center[0]>100&&center[2]>100,"Both outgoing and incoming clips must be present at cut midpoint");
    assert(outside[0]<5&&outside[2]<5,"Transition masks should not expose pixels outside their shapes");
  });
  await check("Different blend modes retain both transition endpoints and stationary transparent backdrops", async () => {
    const first = await fixture((ctx)=>{ctx.fillStyle="#ff0000";ctx.fillRect(0,0,320,180);});
    const second = await fixture((ctx)=>{ctx.fillStyle="#0000ff";ctx.fillRect(0,0,320,180);});
    const outgoing: Clip = { ...first.clip, track:1,sourceEnd:2,blendMode:"Multiply",maskShape:"Rectangle",maskWidth:.4,maskHeight:.4,opacity:.65 };
    const incoming: Clip = { ...second.clip,id:"incoming",assetId:"second",track:1,start:2,sourceEnd:2,blendMode:"Normal",transition:"Dissolve",transitionDuration:1,maskShape:"Rectangle",maskWidth:.4,maskHeight:.4,opacity:.65 };
    first.project.assets.push({...second.project.assets[0],id:"second"});first.project.clips=[outgoing,incoming];first.sources.set(incoming.id,second.image);first.project.background="#808080";
    const c=canvas(),before=canvas(),after=canvas(),r=new Renderer();
    r.draw(before,first.project,1.49999,first.sources);r.draw(after,first.project,2.5,first.sources);
    const delta=(a:HTMLCanvasElement,b:HTMLCanvasElement)=>Math.max(...pixel(a,160,90).map((n,i)=>Math.abs(n-pixel(b,160,90)[i])));
    for(const transition of TRANSITIONS.filter((transition)=>transition.name!=="None")) {
      incoming.transition=transition.name;
      r.draw(c,first.project,1.5,first.sources);assert(delta(c,before)<=2,transition.name+" changed outgoing blend at its start");
      r.draw(c,first.project,2.49999,first.sources);assert(delta(c,after)<=2,transition.name+" changed incoming blend at its end");
    }
    const lower=await fixture((ctx)=>{const g=ctx.createLinearGradient(0,0,320,0);g.addColorStop(0,"#204060");g.addColorStop(1,"#a0c0e0");ctx.fillStyle=g;ctx.fillRect(0,0,320,180);});
    const lowerClip={...lower.clip,id:"lower",assetId:"lower",track:0};first.project.assets.push({...lower.project.assets[0],id:"lower"});
    outgoing.maskWidth=incoming.maskWidth=.2;incoming.transition="Slide left";
    first.project.clips=[lowerClip,outgoing,incoming];first.sources.set(lowerClip.id,lower.image);
    r.draw(before,{...first.project,clips:[lowerClip]},2,first.sources);r.draw(c,first.project,2,first.sources);
    const expected=pixel(before,80,90),actual=pixel(c,80,90);
    assert(actual.every((n,i)=>Math.abs(n-expected[i])<=2),"Slide moved the lower backdrop through a transparent mask");
    r.dispose();
    assert(r.bounds.length===0,"Dispose should release current player bounds");
  });
}
