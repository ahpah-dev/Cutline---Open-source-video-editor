import test from "node:test";
import assert from "node:assert/strict";
import { exportAudioControl, exportFrameCount, exportFrameTime, panStereo } from "../app/editor/exportTiming";
import { makeClip, newProject, type Asset } from "../app/editor/model";

test("Offline frame indices are deterministic, cover sub-second edits and tolerate floating point endpoints",()=>{
  for(const fps of [24,30,60,120]) {
    assert.equal(exportFrameCount(3,fps),3*fps);
    assert.equal(exportFrameCount(.1+.2,fps),Math.ceil(.3*fps));
    for(let i=0;i<3*fps;i++)assert.equal(exportFrameTime(i,fps),i/fps);
  }
  assert.equal(exportFrameCount(.01,30),1);
});
test("Offline audio controls preserve both sides of real joins, mute, fade, freeze and pan through inactive endpoints",()=>{
  const asset:Asset={id:"tone",name:"Tone.mp4",kind:"video",duration:5,sizeLabel:"1 KB",theme:"video"};
  const first={...makeClip(asset,0,1),sourceEnd:1,audioPan:-1},second={...makeClip(asset,1,1),sourceStart:1,sourceEnd:2,transition:"Dissolve" as const,transitionDuration:.4};
  const project={...newProject(),assets:[asset],clips:[first,second]};
  assert.ok(Math.abs(exportAudioControl(project,first,.9).gain-.75)<1e-8);
  assert.ok(Math.abs(exportAudioControl(project,second,.9).gain-.25)<1e-8);
  assert.equal(exportAudioControl(project,first,3).pan,-1);
  assert.equal(exportAudioControl({...project,mutedTracks:["layer:1"]},first,.5).gain,0);
  assert.equal(exportAudioControl(project,{...first,frozenAt:.4},.5).gain,0);
  assert.equal(exportAudioControl(project,{...first,fadeIn:1},.5).gain,.5);
});
test("Equal-power pan preserves mono center and hard-left/right stereo channel isolation",()=>{
  assert.deepEqual(panStereo(.5,.25,-1,false),[.75,0]);
  assert.ok(Math.abs(panStereo(.5,.25,1,false)[0])<1e-12);
  const [l,r]=panStereo(.5,.5,0,true);assert.ok(Math.abs(l-r)<1e-12);assert.ok(Math.abs(l*l+r*r-.25)<1e-12);
});
