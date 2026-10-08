import test from "node:test";
import assert from "node:assert/strict";
import { makeClip, makeText, newProject, type Asset } from "../app/editor/model";
import { mediaDeletionInfo, removeProjectMedia } from "../app/editor/mediaDeletion";
import { historyReducer } from "../app/editor/useProject";

test("Media deletion removes every source-linked clip and only its generated markers, as one undoable edit", () => {
  const asset: Asset = {id:"source",name:"Image.png",kind:"image",duration:5,sizeLabel:"1 KB",theme:"image"};
  const other = {...asset,id:"other"};
  const first=makeClip(asset,0,1),second=makeClip(asset,5,2),third=makeClip(other,0,0),text=makeText();
  const project={...newProject(),assets:[asset,other],clips:[first,second,third],texts:[text],markers:[
    {id:"manual",kind:"beat" as const,time:1},
    {id:"auto",kind:"beat" as const,time:2,source:"auto" as const,sourceClipId:first.id},
    {id:"other-guide",kind:"moment" as const,time:3,source:"scene" as const,sourceClipId:third.id},
  ]};
  assert.deepEqual(mediaDeletionInfo(project,asset.id),{clipCount:2,locked:false});
  const state={project,past:[],future:[],origin:null,group:"",at:0};
  const edited=historyReducer(state,{type:"edit",fn:p=>removeProjectMedia(p,asset.id),group:"",at:1});
  assert.equal(edited.project.assets.length,1);assert.deepEqual(edited.project.clips,[third]);
  assert.deepEqual(edited.project.texts,[text]);assert.deepEqual(edited.project.markers?.map(m=>m.id),["manual","other-guide"]);
  assert.deepEqual(historyReducer(edited,{type:"undo"}).project,project);
  assert.equal(removeProjectMedia(project,"missing"),project);
});
test("Media in a locked layer cannot be deleted, even when other instances are unlocked", () => {
  const asset:Asset={id:"locked-source",name:"Audio.wav",kind:"audio",duration:5,sizeLabel:"1 KB",theme:"audio"};
  const project={...newProject(),assets:[asset],clips:[makeClip(asset,0,0),makeClip(asset,2,1)],lockedTracks:["layer:1"]};
  assert.equal(mediaDeletionInfo(project,asset.id).locked,true);
  assert.throws(()=>removeProjectMedia(project,asset.id),/Unlock/);assert.equal(project.clips.length,2);
});
