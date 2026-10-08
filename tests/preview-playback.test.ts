import test from 'node:test';
import assert from 'node:assert/strict';
import { makeClip, newProject, type Asset } from '../app/editor/model';
import { mediaToTimeline, previewMediaStates, PreviewClock } from '../app/editor/previewPlayback';

test('Preview clock follows real media rather than elapsed UI time, and freezes during startup/buffering', () => {
  const clock = new PreviewClock(3,10);
  assert.equal(clock.sample(12,undefined,true),3);
  assert.equal(clock.sample(15,3.025),3.025);
  assert.equal(clock.sample(18,3.04),3.04);
  assert.equal(clock.sample(19,8,true),3.04);
  assert.equal(clock.sample(20,3.045),3.045);
  assert.equal(clock.sample(21,2.9),3.045,'Master changes must not rewind the timeline');
});
test('Text/images/gaps use a monotonic fallback with no catch-up after buffering', () => {
  const clock = new PreviewClock(0,1);
  assert.equal(clock.sample(1.5),.5);
  assert.equal(clock.sample(9,undefined,true),.5);
  assert.equal(clock.sample(9.25),.75);
  assert.equal(clock.sample(9),.75);
  assert.equal(clock.sample(12,undefined,false,1),1,'An overdue UI frame must not skip the next audio clip');
});
test('Audio master mapping respects clip placement, source trim and speed', () => {
  const asset: Asset = {id:'song',name:'Song',kind:'audio',duration:20,theme:'audio',sizeLabel:'1 MB'};
  const clip = {...makeClip(asset,4),sourceStart:2,sourceEnd:10,speed:1.5};
  assert.equal(mediaToTimeline(clip,2),4);
  assert.equal(mediaToTimeline(clip,5),6);
  const p = newProject();p.assets=[asset];p.clips=[clip];
  assert.equal(previewMediaStates(p,3).length,0);
  assert.equal(previewMediaStates(p,5)[0].volume,1);
  assert.equal(previewMediaStates({...p,mutedTracks:[`layer:${clip.track}`]},5)[0].volume,0);
  assert.equal(previewMediaStates({...p,hiddenTracks:[`layer:${clip.track}`]},5)[0].volume,0);
});
test('Preview audio uses both sides of the actual transition, with independent source clocks', () => {
  const asset: Asset = {id:'film',name:'Film',kind:'video',duration:10,theme:'video',sizeLabel:'1 MB'};
  const p = newProject();p.assets=[asset];
  const outgoing={...makeClip(asset,0,1),sourceEnd:2};
  const incoming={...makeClip(asset,2,1),sourceStart:2,sourceEnd:4,transition:'Dissolve' as const,transitionDuration:.4};
  p.clips=[outgoing,incoming];
  const states=previewMediaStates(p,1.9);
  assert.equal(states.length,2);
  assert.ok(Math.abs(states.find(s=>s.clip.id===outgoing.id)!.volume-.75)<1e-6);
  assert.ok(Math.abs(states.find(s=>s.clip.id===incoming.id)!.volume-.25)<1e-6);
  assert.equal(mediaToTimeline(incoming,1.9),1.9);
});
