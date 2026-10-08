import { makeText, newProject } from "../app/editor/model";
import { Renderer } from "../app/editor/renderer";
import { TEXT_SEQUENCE_ANIMATIONS } from "../app/editor/textSequence";
import { exportFormats, exportProject } from "../app/editor/media";
import { createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { Inspector } from "../app/editor/Inspector";
type Check = (name: string, run: () => unknown) => Promise<void>;
type Assert = (value: unknown, message: string) => void;
const canvas = () => { const c=document.createElement("canvas"); c.width=640;c.height=360;c.getContext("2d",{willReadFrequently:true});return c; };
const hash = (c:HTMLCanvasElement) => {let n=2166136261;for(const byte of c.getContext("2d")!.getImageData(0,0,c.width,c.height).data)n=Math.imul(n^byte,16777619);return n>>>0;};
export async function runTextSequenceChecks(check:Check,assert:Assert) {
  const text=makeText(0,{text:"Make it\nyour story",fontFamily:"Arial",fontSize:150,shadowBlur:0,shadowOffset:0,background:false,animationDuration:1,exitAnimationDuration:1});
  const project={...newProject(),texts:[text]},c=canvas(),out=canvas(),renderer=new Renderer();
  renderer.draw(c,project,2,new Map());const settled=hash(c);
  renderer.draw(c,{...project,texts:[]},0,new Map());const empty=hash(c);
  await check("Every new text sequence animates distinct entrance/exit pixels, hides at start, settles exactly and matches fresh export frames",()=>{
    const signatures=new Set<string>();
    for(const name of [...TEXT_SEQUENCE_ANIMATIONS,"Typewriter"] as const){
      const animated={...project,texts:[{...text,animation:name,exitAnimation:name}]};let signature="";
      renderer.draw(c,animated,0,new Map());assert(hash(c)===empty,name+" visible at start");
      for(const time of [.15,.4,.8,3.2,3.6,3.85]){
        renderer.draw(c,animated,time,new Map());assert(hash(c)!==settled,name+" not animated at "+time);
        new Renderer().draw(out,animated,time,new Map());assert(hash(c)===hash(out),name+" preview/export disagreement");signature+=hash(c)+",";
      }
      assert(!signatures.has(signature),name+" duplicates another text treatment");signatures.add(signature);
      renderer.draw(c,animated,2,new Map());assert(hash(c)===settled,name+" did not settle exactly");
    }
  });
  await check("Grouping, order, stagger, direction, overshoot, flip axis and per-layer timing produce actual editable pixels",()=>{
    const render=(name:typeof TEXT_SEQUENCE_ANIMATIONS[number],settings:Record<string,unknown>,time=.35)=>{
      const p={...project,texts:[{...text,animationStack:[{name,settings}],exitAnimationStack:[{name,settings}]}]};renderer.draw(c,p,time,new Map());return hash(c);
    };
    const base=render("Letter Slide",{});
    for(const settings of [{unit:"word"},{unit:"line"},{order:"reverse"},{order:"center-out"},{order:"edges-in"},{order:"random",seed:7},{stagger:0},{stagger:.95},{angle:0},{distance:.1},{delay:.4},{span:.2},{easing:"back"},{easing:"spring"}])assert(render("Letter Slide",settings)!==base,"Ignored sequence setting "+JSON.stringify(settings));
    assert(render("Word Pop",{overshoot:0})!==render("Word Pop",{overshoot:1}),"Overshoot ignored");
    assert(render("Letter Flip",{flipAxis:"horizontal"})!==render("Letter Flip",{flipAxis:"vertical"}),"Flip axis ignored");
    assert(render("Word Pop",{zoomDirection:"in"},3.7)!==render("Word Pop",{zoomDirection:"out"},3.7),"Exit zoom direction ignored");
  });
  await check("Mixed text sequence stacks preserve Unicode/layout/gradient/stroke and can stack with whole-clip motion and effects",()=>{
    const styled={...text,text:"AVATAR 👩‍💻\ne\u0301 = é",align:"right" as const,letterSpacing:5,strokeWidth:2,fillMode:"linear" as const,gradientAngle:20,shadowBlur:5,
      animationStack:[{name:"Letter Slide" as const,settings:{unit:"letter" as const,order:"reverse" as const}},{name:"Word Pop" as const,settings:{unit:"word" as const,stagger:.3}},{name:"Fade" as const,settings:{}}],
      comboAnimations:[{name:"Float" as const,speed:1,amount:30}],effects:[{name:"Glow" as const,amount:30}]};
    const stacked={...project,texts:[styled]};renderer.draw(c,stacked,.4,new Map());new Renderer().draw(out,stacked,.4,new Map());
    assert(hash(c)===hash(out),"Styled mixed stack is not repeatable");
    const typing={...project,texts:[{...text,text:styled.text,animation:"Typewriter" as const}]};
    renderer.draw(c,typing,.2,new Map());const first={...renderer.bounds[0]};renderer.draw(c,typing,.8,new Map());const later=renderer.bounds[0];
    assert(first.x===later.x&&first.y===later.y&&first.width===later.width&&first.height===later.height,"Typewriter anchor/bounds move while typing");
  });
  await check("Sequence controls accept native input, save exact custom settings and reset only the selected layer",async()=>{
    const host=document.createElement("div");document.body.appendChild(host);const root=createRoot(host);let observed=project;
    const storageKey="cutline:custom-animation-presets:v1",previous=localStorage.getItem(storageKey);
    const wait=()=>new Promise(resolve=>setTimeout(resolve,25));
    function Harness(){const [p,set]=useState(project);observed=p;return createElement(Inspector,{project:p,selection:{kind:"text",id:text.id},time:.2,clear:()=>{},edit:fn=>set(fn)});}
    const button=(label:string)=>host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
    const input=async(label:string,value:string)=>{const field=host.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(field,value);field.dispatchEvent(new Event("input",{bubbles:true}));await wait();};
    try {
      root.render(createElement(Harness));await wait();
      [...host.querySelectorAll<HTMLButtonElement>(".inspector-tabs button")].find(b=>b.textContent==="Animation")!.click();await wait();
      button("Entrance Letter Slide").click();await wait();button("Entrance Word Pop").click();await wait();button("Edit Letter Slide in entrance stack").click();await wait();
      const unit=host.querySelector('[aria-label="Animate by"]') as unknown as HTMLSelectElement;unit.value="word";unit.dispatchEvent(new Event("change",{bubbles:true}));await wait();
      await input("Stagger value","80");await input("Start delay value","20");await input("Active span value","60");
      const settings=observed.texts[0].animationStack![0].settings;
      assert(settings.unit==="word"&&settings.stagger===.8&&settings.delay===.2&&settings.span===.6,"Native settings edits not stored");
      await input("New animation preset name","Sequence recipe");host.querySelector<HTMLButtonElement>('[title="Save current animation stack"]')!.click();await wait();
      const saved=JSON.parse(localStorage.getItem(storageKey)!).find((preset:{name:string})=>preset.name==="Sequence recipe");
      assert(saved?.layers[0].settings.stagger===.8&&saved.layers[0].settings.unit==="word","Custom recipe lost controls");
      button("Reset Letter Slide settings").click();await wait();assert(observed.texts[0].animationStack![0].settings.unit==="letter"&&observed.texts[0].animationStack![1].name==="Word Pop","Reset affected another layer");
      await input("Search animations","flip");assert(button("Entrance Letter Flip")&&!button("Entrance Letter Slide"),"Animation search did not filter presets");button("Clear animation search").click();await wait();
    } finally {root.unmount();host.remove();if(previous===null)localStorage.removeItem(storageKey);else localStorage.setItem(storageKey,previous);}
  });
  await check("A real encoded video retains the text sequence entrance, settled title and exit",async()=>{
    const format=exportFormats()[0];assert(format,"No video encoder available");
    const exporting={...project,texts:[{...text,duration:3,text:"Your story",animation:"Letter Slide" as const,exitAnimation:"Letter Pop In" as const}]};
    const blob=await exportProject(exporting,{resolution:720,fps:30,mime:format.mime,onProgress(){},signal:new AbortController().signal});
    const video=document.createElement("video"),url=URL.createObjectURL(blob);video.muted=true;const frame=canvas();
    const ink=()=>{let sum=0;const data=frame.getContext("2d")!.getImageData(0,0,640,360).data;for(let i=0;i<data.length;i+=4)if(data[i]+data[i+1]+data[i+2]>380)sum++;return sum;};
    try {
      await new Promise<void>((resolve,reject)=>{video.onloadeddata=()=>resolve();video.onerror=()=>reject(new Error("Text export failed to decode"));video.src=url;});
      const sample=async(time:number)=>{
        await new Promise<void>((resolve,reject)=>{
          const timer=setTimeout(()=>reject(new Error(`Text export seek timed out (${time}/${video.duration})`)),5000);
          video.onseeked=()=>{clearTimeout(timer);resolve();};video.currentTime=Math.min(time,video.duration-.025);
        });
        // Seek completion can precede presentation of the newly decoded frame.
        await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
        frame.getContext("2d")!.drawImage(video,0,0,640,360);return ink();
      };
      const early=await sample(.1),middle=await sample(1.5),late=await sample(2.9);
      assert(middle>100,"Settled exported title has no visible ink");assert(early<middle*.75&&late<middle*.75,`Encoded animations were lost: ${early}/${middle}/${late} (duration ${video.duration})`);
    } finally {video.pause();video.removeAttribute("src");video.load();URL.revokeObjectURL(url);}
  });
}
