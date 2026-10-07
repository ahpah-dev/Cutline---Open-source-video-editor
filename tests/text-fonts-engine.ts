import { makeText, newProject } from "../app/editor/model";
import { ensureTextFonts, textFont } from "../app/editor/textFonts";
import { MediaPool } from "../app/editor/media";
import { Renderer } from "../app/editor/renderer";

type Check = (name: string, fn: () => unknown) => Promise<void>;
const assert = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const latin = new URL("../node_modules/@fontsource-variable/manrope/files/manrope-latin-wght-normal.woff2", window.location.href).href;
const cyrillic = new URL("../node_modules/@fontsource-variable/manrope/files/manrope-cyrillic-wght-normal.woff2", window.location.href).href;

export async function runTextFontChecks(check: Check) {
  await check("Cold Manrope is loaded before text preparation resolves and invalidates paused preview", async () => {
    const family = "Cutline Cold Manrope";
    const face = new FontFace(family, `url("${latin}")`, {weight:"200 800"});
    document.fonts.add(face);
    const text = {...makeText(), text:"New Text Wide WWW iii", fontFamily:family, fontWeight:650, padding:0, animation:"None" as const};
    const project = {...newProject(), texts:[text]}, pool = new MediaPool(), renderer = new Renderer();
    const canvas = document.createElement("canvas");canvas.width=1920;canvas.height=1080;
    try {
      assert(face.status === "unloaded", "Font fixture was already loaded");
      renderer.draw(canvas, project, .5, new Map());const fallback = renderer.bounds[0].width;
      const revision = pool.revision, ready = pool.ensure(project);
      assert(!pool.textFontsReady, "Preview can render before fonts are prepared");
      await ready;
      assert(face.status === "loaded" && pool.textFontsReady, "Selected Manrope was not loaded");
      assert(pool.revision > revision, "Paused preview won't redraw after font load");
      renderer.draw(canvas, project, .5, new Map());const loaded = renderer.bounds[0].width;
      assert(Math.abs(loaded - fallback) > 1, "Renderer still measures fallback rather than Manrope");
      const context = canvas.getContext("2d")!;context.font=textFont(text,text.fontSize);
      assert(Math.abs(loaded-context.measureText(text.text).width) < 1, "Text selection bounds disagree with loaded font metrics");
      const before=loaded; await pool.ensure(project);renderer.draw(canvas,project,.5,new Map());
      assert(Math.abs(renderer.bounds[0].width-before)<.01,"Saved-project reload changed text metrics");
    } finally {pool.dispose();renderer.dispose();document.fonts.delete(face);}
  });
  await check("Text-font preparation includes non-Latin text and animated family/weight/italic values", async () => {
    const family = "Cutline Cyrillic Manrope";
    const face = new FontFace(family,`url("${cyrillic}")`,{weight:"200 800",unicodeRange:"U+0400-04FF"});
    document.fonts.add(face);
    try {
      const text={...makeText(),text:"New Text",fontFamily:"Arial",propertyKeyframes:{fontFamily:[{time:1,value:family}],text:[{time:1,value:"Добро јутро"}],fontWeight:[{time:1,value:750}],italic:[{time:1,value:true}]}};
      await ensureTextFonts({texts:[text]});
      assert(face.status==="loaded","Actual animated Cyrillic characters didn't load their font subset");
    } finally {document.fonts.delete(face);}
  });
  await check("Failed font loads are reported and can be retried instead of permanently caching fallback", async () => {
    const text=makeText();let loads=0;
    const fonts={check:()=>false,load:async()=>{if(++loads===1)throw new Error("offline");return [];}} as unknown as FontFaceSet;
    let failed=false;try{await ensureTextFonts({texts:[text]},fonts);}catch(e){failed=String(e).includes(text.fontFamily);}
    assert(failed,"Font load failure was silently ignored");await ensureTextFonts({texts:[text]},fonts);
    assert(loads===2,"Failed font request wasn't retried");
  });
}
