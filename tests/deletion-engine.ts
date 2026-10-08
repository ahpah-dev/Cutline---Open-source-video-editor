import { createElement } from "react";
import { createRoot } from "react-dom/client";
import Editor from "../app/Editor";
import { deleteSavedProject, listProjects, loadMediaAsset, loadProject, saveMediaAsset, saveProject } from "../app/editorStorage";
import { makeClip, newProject, uid, type Asset } from "../app/editor/model";
import { persistable } from "../app/editor/useProject";
import { removeProjectMedia } from "../app/editor/mediaDeletion";
type Check = (name: string, run: () => unknown) => Promise<void>;
type Assert = (value: unknown, message: string) => void;
const wait = (ms=25) => new Promise(resolve=>setTimeout(resolve,ms));
async function until(test:()=>boolean,timeout=10000) { const end=performance.now()+timeout;while(!test()){if(performance.now()>end)throw new Error("Deletion UI timed out");await wait();} }
async function fixture(name:string) {
  const canvas=document.createElement("canvas");canvas.width=160;canvas.height=90;const ctx=canvas.getContext("2d")!;ctx.fillStyle="#349f7a";ctx.fillRect(0,0,160,90);
  const blob=await new Promise<Blob>(resolve=>canvas.toBlob(b=>resolve(b!),"image/png"));
  const asset:Asset={id:uid("deletion-asset"),name,kind:"image",duration:5,sizeLabel:"1 KB",theme:"image",width:160,height:90};
  const media={...asset,kind:"image" as const,blob};await saveMediaAsset(media);return {asset,media};
}
export async function runDeletionChecks(check:Check,assert:Assert) {
  await check("Deleting a saved project reclaims only exclusive media and rejects stale saves or overwriting another project",async()=>{
    const shared=await fixture("Shared.png"),unique=await fixture("Exclusive.png"),pending=await fixture("Pending import.png");
    const first={...newProject(),name:"Delete first",assets:[shared.asset,unique.asset]},second={...newProject(),name:"Keep second",assets:[shared.asset]};
    await saveProject(persistable(first));await saveProject(persistable(second));
    await deleteSavedProject(first.id);
    assert(!(await listProjects()).some(p=>"id" in p&&p.id===first.id),"Deleted archive remained");
    assert(await loadMediaAsset(shared.asset.id),"Shared media deleted");assert(!await loadMediaAsset(unique.asset.id),"Exclusive media not reclaimed");assert(await loadMediaAsset(pending.asset.id),"Pending import incorrectly reclaimed");
    let refused=false;try{await saveProject(persistable(first),[shared.media,unique.media]);}catch{refused=true;}
    assert(refused&&!await loadMediaAsset(unique.asset.id),"Stale save resurrected deleted project/media");
    let guarded=false;try{await deleteSavedProject(second.id,persistable(second));}catch{guarded=true;}
    assert(guarded&&(await listProjects()).some(p=>"id" in p&&p.id===second.id),"Active-delete guard was not atomic");
    const third=newProject();await saveProject(persistable(third));await saveProject(persistable(second));
    let conflict=false;try{await deleteSavedProject(second.id,persistable(third));}catch{conflict=true;}
    assert(conflict,"Deleting current project overwrote another archive");
    const replacement=newProject();await deleteSavedProject(second.id,persistable(replacement));
    const loaded=await loadProject();assert(loaded.project&&"id" in loaded.project&&loaded.project.id===replacement.id,"Current workspace did not switch atomically");
  });
  await check("Saving removed media reclaims its unused copy, and Undo restores the original blob while keeping shared media safe",async()=>{
    const source=await fixture("Undo media.png");const project={...newProject(),assets:[source.asset],clips:[makeClip(source.asset)]};
    await saveProject(persistable(project));await saveProject(persistable(removeProjectMedia(project,source.asset.id)));
    assert(!await loadMediaAsset(source.asset.id),"Removed media still stored");
    await saveProject(persistable(project),[source.media]);assert((await loadMediaAsset(source.asset.id))?.blob.size===source.media.blob.size,"Undo did not restore blob");
    const other={...newProject(),assets:[source.asset]};await saveProject(persistable(other));await saveProject(persistable(project));
    await saveProject(persistable(removeProjectMedia(project,source.asset.id)));
    assert(await loadMediaAsset(source.asset.id),"Media still used by another project was deleted");
  });
  await check("Live Editor media/project delete controls confirm, cancel, undo, protect shared projects and prevent autosave resurrection",async()=>{
    const source=await fixture("Deletion UI.png"),current={...newProject(),name:"Delete UI current",assets:[source.asset],clips:[makeClip(source.asset,0,1),makeClip(source.asset,0,2)]};
    const other={...newProject(),name:"Keep UI project",assets:[source.asset]};await saveProject(persistable(other));await saveProject(persistable(current));
    const host=document.createElement("div");document.body.appendChild(host);const root=createRoot(host);
    const button=(label:string)=>host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
    const dialog=()=>host.querySelector<HTMLDialogElement>('[aria-label="Delete media?"], [aria-label="Delete project?"]');
    const confirm=()=>dialog()!.querySelector<HTMLButtonElement>('.destructive')!;
    try {
      root.render(createElement(Editor));await until(()=>!!button("Delete Deletion UI.png from project")&&!host.querySelector('.busy-indicator'));
      button("Delete Deletion UI.png from project").click();await until(()=>!!dialog()?.open);
      assert(dialog()!.textContent!.includes("2 timeline clips"),"Confirmation omitted clip usage");
      dialog()!.querySelector<HTMLButtonElement>('.dialog-actions .secondary')!.click();await until(()=>!dialog());assert(button("Delete Deletion UI.png from project"),"Cancel deleted media");
      button("Delete Deletion UI.png from project").click();await until(()=>!!dialog());confirm().click();await until(()=>!button("Delete Deletion UI.png from project"));
      assert(!host.querySelector(`[data-clip-id="${current.clips[0].id}"]`),"Used clips not removed");
      button("Undo").click();await until(()=>!!button("Delete Deletion UI.png from project"));
      assert(host.querySelector(`[data-clip-id="${current.clips[1].id}"]`),"Undo lost a clip");
      [...host.querySelectorAll<HTMLButtonElement>('.project-menu button')].find(b=>b.textContent?.includes('My projects'))!.click();
      await until(()=>!!button("Delete project Keep UI project"));button("Delete project Keep UI project").click();await until(()=>!!dialog());
      dialog()!.querySelector<HTMLButtonElement>('.dialog-actions .secondary')!.click();await until(()=>!dialog());assert(button("Delete project Keep UI project"),"Cancel removed archive");
      button("Delete project Delete UI current").click();await until(()=>!!dialog());confirm().click();await until(()=>!dialog()&&!host.querySelector(`[data-project-id="${current.id}"]`));
      await wait(350);window.dispatchEvent(new Event("pagehide"));await wait(350);
      const projects=await listProjects(),loaded=await loadProject();
      assert(!projects.some(p=>"id" in p&&p.id===current.id),"Autosave resurrected deleted archive");
      assert(projects.some(p=>"id" in p&&p.id===other.id)&&await loadMediaAsset(source.asset.id),"Deleting current broke another project");
      assert(loaded.project&&"id" in loaded.project&&loaded.project.id!==current.id,"Deleted project remains current");
      assert(button("Undo").disabled,"Delete active project left old undo history");
    } finally {root.unmount();host.remove();}
  });
}
