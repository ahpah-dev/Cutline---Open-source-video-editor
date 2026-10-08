import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { Inspector } from "../app/editor/Inspector";
import { makeText, makeClip, migrateProject, newProject, splitItem, type TextAnimationOptions, type Project } from "../app/editor/model";
import { animationLayers } from "../app/editor/textAnimation";
import { TEXT_SEQUENCE_ANIMATIONS, segmentTextUnits, sequenceDefaults, sequenceRanks, sequenceUnitProgress, sequenceUnitMotion, layerProgress, easeAnimation } from "../app/editor/textSequence";
import { sanitizeAnimationSettings, createCustomAnimationPreset, parseCustomAnimationPresets } from "../app/editor/customAnimationPresets";
import { applyCodexEdits, editingCatalog, projectRevision } from "../app/editor/codexEditing";

test("Text sequences keep emoji and combining accents together, with word/line units and bounded long titles", () => {
  const text = "A 👩‍💻 e\u0301\nB", lines = text.split("\n");
  assert.deepEqual(segmentTextUnits(text, "letter").map(u => lines[u.line].slice(u.start, u.end)), ["A", "👩‍💻", "e\u0301", "B"]);
  assert.equal(segmentTextUnits("Hello, world!\nNew title", "word").length, 4);
  assert.equal(segmentTextUnits("\nHello\n\nworld", "line").length, 2);
  assert.ok(segmentTextUnits("a".repeat(20000), "letter").length <= 256);
});
test("Reveal orders are deterministic permutations; entrance and exit both honor the selected order", () => {
  for (const order of ["forward", "reverse", "center-out", "edges-in", "random"] as const) {
    const ranks = sequenceRanks(7, order, 12);
    assert.deepEqual([...ranks].sort((a,b)=>a-b), [0,1,2,3,4,5,6]);
    assert.deepEqual(ranks, sequenceRanks(7, order, 12));
  }
  assert.deepEqual(sequenceRanks(5, "center-out"), [3,1,0,2,4]);
  assert.notDeepEqual(sequenceRanks(12, "random", 12), sequenceRanks(12, "random", 99));
  const layer = { name: "Letter Fade" as const, progress: 0.2, exiting: false, settings: { stagger: 0.6 } };
  assert.ok(sequenceUnitProgress(layer, 0, 4) > sequenceUnitProgress(layer, 3, 4));
  assert.ok(sequenceUnitProgress({ ...layer, progress: 0.8, exiting: true }, 0, 4) < sequenceUnitProgress({ ...layer, progress: 0.8, exiting: true }, 3, 4));
  for (const exiting of [false,true]) for (const rank of [0,1,2,3]) {
    assert.equal(sequenceUnitProgress({ ...layer, exiting, progress: 1 }, rank, 4), 1);
    assert.equal(sequenceUnitProgress({ ...layer, exiting, progress: 0 }, rank, 4), 0);
  }
});
test("Layer delay/span stays within each phase and spring/back easing settles exactly", () => {
  assert.equal(layerProgress(0.1, false, { delay: 0.2, span: 0.4 }), 0);
  assert.equal(layerProgress(0.8, false, { delay: 0.2, span: 0.4 }), 1);
  assert.equal(layerProgress(0.9, true, { delay: 0.2, span: 0.4 }), 1);
  assert.equal(layerProgress(0.2, true, { delay: 0.2, span: 0.4 }), 0);
  for (const easing of ["back", "spring"] as const) { assert.equal(easeAnimation(0,easing),0); assert.equal(easeAnimation(1,easing),1); }
  assert.equal(layerProgress(1, false, { delay: 0.95, span: 1 }), 1);
});
test("New unit motions are tunable, finite and neutral at their full-visible endpoint", () => {
  for (const name of TEXT_SEQUENCE_ANIMATIONS) for (const exiting of [false,true]) {
    const layer = { name, exiting, progress: 0.4, settings: sequenceDefaults(name) };
    for (const progress of [0,0.1,0.4,0.9,1]) {
      const motion = sequenceUnitMotion({ ...layer, progress }, 0, 3);
      assert.ok(Object.values(motion).every(Number.isFinite), name);
      assert.ok(motion.opacity >= 0 && motion.opacity <= 1);
    }
    assert.deepEqual(sequenceUnitMotion({ ...layer, progress: 1 }, 2, 3), { x:0,y:0,scaleX:1,scaleY:1,rotation:0,blur:0,opacity:1 });
  }
  const slide = { name:"Letter Slide" as const,exiting:false,progress:0.2,settings:{...sequenceDefaults("Letter Slide"),stagger:0,angle:0,distance:0.15} };
  assert.ok(sequenceUnitMotion(slide,0,1).x>0); assert.ok(Math.abs(sequenceUnitMotion(slide,0,1).y)<1e-9);
  const pop = { ...slide, name:"Word Pop" as const, exiting:true, settings:{...slide.settings,zoomAmount:0.8,zoomDirection:"in" as const} };
  assert.ok(sequenceUnitMotion(pop,0,1).scaleX>1);
  assert.ok(sequenceUnitMotion({...pop,settings:{...pop.settings,zoomDirection:"out"}},0,1).scaleX<1);
});
test("Sequence settings persist in recipes, backups and split phases, and reject unsafe option values", () => {
  const settings: TextAnimationOptions = { unit:"word",order:"random",stagger:0.8,seed:17,delay:0.1,span:0.5,overshoot:0.6,flipAxis:"vertical",easing:"spring" };
  const preset = createCustomAnimationPreset("Word spring", "Entrance", "Word Pop", 1.2, settings);
  assert.deepEqual(parseCustomAnimationPresets(JSON.stringify([preset]))[0], preset);
  const text = makeText(0,{animation:"Word Pop",animationStack:[{name:"Word Pop",settings}],exitAnimation:"Letter Flip",exitAnimationStack:[{name:"Letter Flip",settings}]});
  const project={...newProject(),texts:[text]};
  const restored=migrateProject(JSON.parse(JSON.stringify(project)),[]);
  assert.deepEqual(animationLayers(restored.texts[0],"Entrance")[0].settings,settings);
  const split=splitItem(restored,{kind:"text",id:text.id},2).project;
  assert.deepEqual(split.texts[1].exitAnimationStack?.[0].settings,settings);
  assert.deepEqual(sanitizeAnimationSettings({unit:"bad",order:"wrong",delay:Infinity,stagger:4,span:-2,overshoot:2,seed:1.4}),{stagger:0.95,span:0.01,overshoot:1,seed:1});
});
test("AI can precisely edit every new text sequence but rejects them on media and rolls back atomically", () => {
  const text=makeText(),asset={id:"video",name:"Video",kind:"video" as const,duration:4,sizeLabel:"1 KB",theme:"video"};
  const project={...newProject(),assets:[asset],clips:[makeClip(asset)],texts:[text]};
  const layers=TEXT_SEQUENCE_ANIMATIONS.map(name=>({name,settings:{unit:"word",order:"center-out",stagger:0.7,delay:0.1,span:0.8,easing:"back"}}));
  const next=applyCodexEdits(project,{projectId:project.id,expectedRevision:projectRevision(project),operations:[{op:"animation",id:text.id,phase:"Exit",duration:1,layers}]}).project;
  assert.equal(next.texts[0].exitAnimationStack?.length,9);
  assert.equal(next.texts[0].exitAnimationStack?.[0].settings.order,"center-out");
  assert.ok(editingCatalog().textOnlyAnimations.includes("Letter Flip"));
  assert.throws(()=>applyCodexEdits(project,{projectId:project.id,expectedRevision:projectRevision(project),operations:[{op:"project",patch:{name:"Must not persist"}},{op:"animation",id:project.clips[0].id,phase:"Entrance",duration:1,layers:[{name:"Letter Fade"}]}]}),/text animation/);
  assert.notEqual(project.name,"Must not persist");
});
test("Text inspector exposes sequencing controls, independent stacks, search and a per-layer reset", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>',{url:"http://unit.test"});
  Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,Element:dom.window.Element,IS_REACT_ACT_ENVIRONMENT:true});
  globalThis.requestAnimationFrame=()=>1;globalThis.cancelAnimationFrame=()=>{};
  const text=makeText();let observed:Project={...newProject(),texts:[text]};
  function Harness(){const [project,setProject]=useState(observed);observed=project;return createElement(Inspector,{project,selection:{kind:"text",id:text.id},time:0.2,clear:()=>{},edit:fn=>setProject(fn)});}
  const root=createRoot(document.getElementById("root")!);
  const click=async(label:string)=>{const button=document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);assert.ok(button,label);await act(()=>button.click());};
  try {
    await act(()=>root.render(createElement(Harness)));
    await act(()=>[...document.querySelectorAll<HTMLButtonElement>(".inspector-tabs button")].find(b=>b.textContent==="Animation")!.click());
    await click("Entrance Letter Slide"); await click("Entrance Word Pop");
    assert.equal(observed.texts[0].animationStack?.length,2);
    await click("Edit Letter Slide in entrance stack");
    const unit=document.querySelector('[aria-label="Animate by"]') as unknown as HTMLSelectElement;
    await act(()=>{unit.value="word";unit.dispatchEvent(new dom.window.Event("change",{bubbles:true}));});
    assert.equal(observed.texts[0].animationStack?.[0].settings.unit,"word");
    await click("Reset Letter Slide settings");
    assert.equal(observed.texts[0].animationStack?.[0].settings.unit,"letter");
    assert.equal(observed.texts[0].animationStack?.[1].name,"Word Pop");
    await act(()=>[...document.querySelectorAll<HTMLButtonElement>('.animation-phase button')].find(b=>b.textContent==="Exit")!.click());
    await click("Exit Letter Flip");assert.equal(observed.texts[0].exitAnimationStack?.[0].name,"Letter Flip");
    assert.ok(document.querySelector('[aria-label="Flip axis"]'));assert.ok(document.querySelector('[aria-label="Search animations"]'));
  } finally {await act(()=>root.unmount());dom.window.close();}
});
