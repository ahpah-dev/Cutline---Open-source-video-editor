import assert from "node:assert/strict";
import test from "node:test";
import { analyzeBeats, applyBeatMarkers, beatTimes, DEFAULT_BEAT_SETTINGS } from "../app/editor/beatDetection";
import { makeClip, migrateProject, newProject, type Asset } from "../app/editor/model";
import { historyReducer } from "../app/editor/useProject";
import { editingCatalog, projectSnapshot } from "../app/editor/codexEditing";
const rhythm=(bpm=120,duration=12)=>{const samples=new Float32Array(16000*duration),step=60/bpm,times:number[]=[];
  for(let at=.25;at<duration-.1;at+=step){times.push(at);const start=Math.round(at*16000);for(let i=0;i<1600&&start+i<samples.length;i++){samples[start+i]+=Math.sin(i/16000*2*Math.PI*(70+90*Math.exp(-i/16000*30)))*Math.exp(-i/16000*35)*.7;}}
  return {samples,times};};
test("Spectral beat detection tracks real audio timing and estimates several tempos",()=>{
  for(const bpm of [80,120,160]){const {samples,times}=rhythm(bpm);const analysis=analyzeBeats(samples);const detected=beatTimes(analysis,DEFAULT_BEAT_SETTINGS);
    assert.ok(Math.abs(analysis.bpm-bpm)<6,`Expected ${bpm} BPM; got ${analysis.bpm}`);
    const matched=times.filter(t=>detected.some(d=>Math.abs(d-t)<.07));
    assert.ok(matched.length/times.length>.8,`${bpm}: only ${matched.length}/${times.length} beats matched ${JSON.stringify(detected)}`);
    assert.ok(detected.every(t=>t>=0&&t<12));
  }
});
test("Beat density, offset, sensitivity and BPM override refine markers without redecoding audio",()=>{
  const analysis=analyzeBeats(rhythm().samples),normal=beatTimes(analysis,DEFAULT_BEAT_SETTINGS);
  const half=beatTimes(analysis,{...DEFAULT_BEAT_SETTINGS,spacing:2}),double=beatTimes(analysis,{...DEFAULT_BEAT_SETTINGS,spacing:.5});
  assert.equal(half.length,Math.ceil(normal.length/2));assert.ok(double.length>normal.length*1.8);
  const offset=beatTimes(analysis,{...DEFAULT_BEAT_SETTINGS,offsetMs:100});assert.ok(Math.abs(offset[0]-normal[0]-.1)<.001);
  assert.ok(beatTimes(analysis,{...DEFAULT_BEAT_SETTINGS,mode:"hits",sensitivity:100}).length>=beatTimes(analysis,{...DEFAULT_BEAT_SETTINGS,mode:"hits",sensitivity:0}).length);
  assert.ok(beatTimes(analysis,{...DEFAULT_BEAT_SETTINGS,bpm:120}).length>10);
});
test("Silence and sustained tones do not manufacture a regular beat grid",()=>{
  const silence=analyzeBeats(new Float32Array(16000*3));assert.deepEqual(beatTimes(silence,DEFAULT_BEAT_SETTINGS),[]);assert.equal(silence.bpm,0);
  const tone=Float32Array.from({length:16000*4},(_,i)=>Math.sin(i/16000*440*2*Math.PI)*.1),analysis=analyzeBeats(tone);
  assert.ok(beatTimes(analysis,DEFAULT_BEAT_SETTINGS).length<4);
});
test("Automatic guides align to timeline frames, deduplicate, preserve manual moments and undo atomically",()=>{
  const asset:Asset={id:"song",kind:"audio",name:"Song.wav",duration:12,theme:"audio",sizeLabel:"test"};const clip={...makeClip(asset,3),speed:2,sourceStart:2,sourceEnd:10};
  const p={...newProject(),assets:[asset],clips:[clip],markers:[{id:"manual",kind:"beat" as const,time:3.5},{id:"moment",kind:"moment" as const,time:3.5}]};
  const marked=applyBeatMarkers(p,clip.id,[.5,1.001,1.002,2,5,NaN],120);assert.equal(marked.markers.length,4);assert.equal(marked.markers.filter(m=>m.source==="auto").length,2);
  assert.ok(marked.markers.some(m=>m.sourceClipId===clip.id&&m.bpm===120));
  const rerun=applyBeatMarkers(marked,clip.id,[.25],120);assert.equal(rerun.markers.length,3);assert.ok(rerun.markers.some(m=>m.id==="manual"));
  const migrated=migrateProject(rerun,rerun.assets);assert.deepEqual(migrated.markers,rerun.markers);
  const initial={project:p,past:[],future:[],origin:null,group:"",at:0};const edited=historyReducer(initial,{type:"edit",fn:()=>marked,group:"",at:0});assert.deepEqual(historyReducer(edited,{type:"undo"}).project,p);
  assert.equal(projectSnapshot(marked).markers[2].source,"auto");assert.match(editingCatalog().markerSemantics,/locally detected/);
});
