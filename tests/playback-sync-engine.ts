import { createElement, Fragment, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { makeClip, makeText, newProject } from '../app/editor/model';
import { exportFormats, exportProject, inspectFile, MediaPool } from '../app/editor/media';
import { mediaToTimeline } from '../app/editor/previewPlayback';
import { Preview } from '../app/editor/Preview';
import { Timeline } from '../app/editor/Timeline';

type Check = (name:string,run:()=>unknown)=>Promise<void>;
const assert = (value:unknown,message:string) => { if (!value) throw new Error(message); };
const wait = (ms:number) => new Promise(resolve=>setTimeout(resolve,ms));
const frame = () => new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
async function until(run:()=>boolean) { for(let i=0;i<200;i++){if(run())return;await wait(10);}throw new Error('Playback condition timed out'); }
function songFile() {
  const rate=48000,count=rate*8,bytes=new ArrayBuffer(44+count*2),v=new DataView(bytes);
  const text=(at:number,value:string)=>[...value].forEach((c,i)=>v.setUint8(at+i,c.charCodeAt(0)));
  text(0,'RIFF');v.setUint32(4,bytes.byteLength-8,true);text(8,'WAVE');text(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,rate,true);v.setUint32(28,rate*2,true);v.setUint16(32,2,true);v.setUint16(34,16,true);text(36,'data');v.setUint32(40,count*2,true);
  for(let i=0;i<count;i++) v.setInt16(44+i*2,Math.sin(i/rate*Math.PI*880)*(i%rate<2400?18000:6000),true);
  return new File([bytes],'playback-beats.wav',{type:'audio/wav'});
}
function elements(pool:MediaPool) { return (pool as unknown as {elements:Map<string,HTMLMediaElement>}).elements; }

export async function runPlaybackSyncChecks(check:Check) {
  await check('Real decoded video and a separate song stay synchronized after repeated seeks and retiming',async()=>{
    const song=await inspectFile(songFile()),encoded=newProject();encoded.assets=[song];encoded.clips=[{...makeClip(song),sourceEnd:4}];encoded.texts=[makeText(0,{duration:4,text:'Sync fixture'})];
    const format=exportFormats()[0];assert(format,'No video encoder for playback fixture');
    const blob=await exportProject(encoded,{resolution:144,fps:30,mime:format.mime,signal:new AbortController().signal,onProgress(){}});
    const video=await inspectFile(new File([blob],'preview-sync.mp4',{type:blob.type}));
    const p=newProject();p.assets=[video,song];
    const film={...makeClip(video,0,1),sourceStart:.5,sourceEnd:4,speed:1.25,volume:0};
    const audio={...makeClip(song,0,2),sourceStart:1,sourceEnd:7,speed:.75};p.clips=[film,audio];
    const pool=new MediaPool();
    try {
      await pool.ensure(p);
      await Promise.all([pool.sync(p,.5,false),pool.sync(p,1.9,false),pool.sync(p,.2,false),pool.sync(p,1.2,false)]);
      await pool.startPlayback(p,1.2);
      const el=pool.sources.get(film.id) as HTMLVideoElement;
      let maxDrift=0;const began=performance.now();
      while(performance.now()-began<700){await wait(8);await frame();const time=pool.playbackTime(p)!;await pool.sync(p,time,true);if(!pool.playbackBuffering)maxDrift=Math.max(maxDrift,Math.abs(mediaToTimeline(film,el.currentTime)-time));}
      assert(maxDrift<.065,`Actual video/song drift: ${maxDrift}`);
      assert(pool.playbackTime(p)!>1.6,'Video/song playback did not advance');
      console.log(JSON.stringify({previewVideoSongMaxMs:maxDrift*1000}));
    } finally {pool.dispose();URL.revokeObjectURL(video.url!);URL.revokeObjectURL(song.url!);}
  });
  await check('Rapid audio seeks settle on the newest trimmed/speed-adjusted position; delayed startup does not advance the playhead',async()=>{
    const asset=await inspectFile(songFile()),p=newProject();p.assets=[asset];
    const clip={...makeClip(asset,1),sourceStart:1,sourceEnd:7.5,speed:1.25};p.clips=[clip];
    const pool=new MediaPool();
    try {
      await pool.ensure(p);
      await Promise.all([pool.sync(p,1.1,false),pool.sync(p,4.3,false),pool.sync(p,2.2,false),pool.sync(p,3.6,false)]);
      const el=elements(pool).get(clip.id)!;
      assert(Math.abs(el.currentTime-4.25)<.009&&el.paused,'Newest seek was lost or scrub leaked playback');
      const enable=pool.enableAudio.bind(pool);
      pool.enableAudio=async(...args)=>{await wait(160);await enable(...args);};
      const starting=pool.startPlayback(p,3.6);
      await wait(80);
      assert(pool.playbackTime(p)===3.6&&el.paused&&!pool.playbackReady,'Timer ran ahead while audio startup was delayed');
      await starting;
      for(let i=0;i<20;i++) {
        await frame();const time=pool.playbackTime(p)!;
        assert(Math.abs(time-mediaToTimeline(clip,el.currentTime))<.025,`Playhead is not reading the trimmed/speed-adjusted audio clock: ${JSON.stringify({time,source:el.currentTime,mapped:mediaToTimeline(clip,el.currentTime),paused:el.paused,seeking:el.seeking})}`);
        await pool.sync(p,time,true);
      }
      pool.pause();const obsolete=pool.startPlayback(p,1.2);await wait(10);pool.pause();
      const newest=pool.startPlayback(p,4.5);await Promise.all([obsolete,newest]);
      assert(pool.playbackReady&&Math.abs(mediaToTimeline(clip,el.currentTime)-4.5)<.05,'Obsolete startup resumed an old position');
    } finally {pool.dispose();URL.revokeObjectURL(asset.url!);}
  });
  await check('Media-clock playback keeps overlapping retimed audio aligned through intentional UI stalls and pauses',async()=>{
    const asset=await inspectFile(songFile()),p=newProject();p.assets=[asset];
    const a={...makeClip(asset,0,1),sourceStart:1,sourceEnd:7,speed:1.25};
    const b={...makeClip(asset,0,2),sourceStart:2,sourceEnd:7,speed:.75};p.clips=[a,b];
    const pool=new MediaPool();
    try {
      await pool.startPlayback(p,1);
      const first=elements(pool).get(a.id)!,second=elements(pool).get(b.id)!;
      let advancing=1,maxMaster=0,maxLayers=0;
      const began=performance.now();
      for(let i=0;performance.now()-began<1500;i++) {
        await wait(5);await frame();
        if(i%12===5){const end=performance.now()+85;while(performance.now()<end){/* Real main-thread stall, not a fake clock. */}}
        const time=pool.playbackTime(p)!;
        maxMaster=Math.max(maxMaster,Math.abs(time-mediaToTimeline(a,first.currentTime)));
        await pool.sync(p,time,true);
        if(!pool.playbackBuffering) maxLayers=Math.max(maxLayers,Math.abs(mediaToTimeline(a,first.currentTime)-mediaToTimeline(b,second.currentTime)));
        advancing=time;
      }
      assert(advancing>1.8,'Playback stopped advancing');
      assert(maxMaster<.025,`Audio/playhead drift during stalls: ${maxMaster}`);
      assert(maxLayers<.065,`Retimed layers drifted: ${maxLayers}`);
      pool.pause();const position=first.currentTime;await wait(70);
      assert(first.paused&&second.paused&&Math.abs(first.currentTime-position)<.009,'Pause allowed audio to keep running');
      console.log(JSON.stringify({previewMasterMaxMs:maxMaster*1000,previewLayerMaxMs:maxLayers*1000}));
    } finally {pool.dispose();URL.revokeObjectURL(asset.url!);}
  });
  await check('A buffering layer pauses every source, holds the clock, and resumes in sync when data returns',async()=>{
    const asset=await inspectFile(songFile()),p=newProject();p.assets=[asset];
    const a=makeClip(asset,0,1),b=makeClip(asset,0,2);p.clips=[a,b];const pool=new MediaPool();
    try {
      await pool.startPlayback(p,1);await wait(80);
      const time=pool.playbackTime(p)!,first=elements(pool).get(a.id)!,second=elements(pool).get(b.id)!;
      Object.defineProperty(second,'readyState',{configurable:true,get:()=>1});
      await pool.sync(p,time,true);await wait(80);
      assert(first.paused&&second.paused&&pool.playbackBuffering,'Other audible sources continued while a decoder was buffering');
      assert(pool.playbackTime(p)===time,'Buffering advanced the timeline clock');
      Reflect.deleteProperty(second,'readyState');
      await pool.sync(p,time,true);await pool.sync(p,time,true);await wait(50);
      const resumed=pool.playbackTime(p)!;
      assert(!first.paused&&!second.paused&&resumed>time,'Recovered media did not restart the whole transport');
      assert(Math.abs(first.currentTime-second.currentTime)<.065,'Recovered audio sources drifted apart');
    } finally {pool.dispose();URL.revokeObjectURL(asset.url!);}
  });
  await check('Playback crosses an audio cut and silent gap without retaining the previous source clock',async()=>{
    const asset=await inspectFile(songFile()),p=newProject();p.assets=[asset];
    const a={...makeClip(asset,0,1),sourceStart:1,sourceEnd:1.3};
    const b={...makeClip(asset,.55,1),sourceStart:4,sourceEnd:4.5};p.clips=[a,b];
    const pool=new MediaPool();
    try {
      await pool.startPlayback(p,.1);let last=.1,passedGap=false,heardSecond=false;
      const began=performance.now();
      for(let i=0;performance.now()-began<1800;i++) {
        await wait(5);await frame();const time=pool.playbackTime(p)!;assert(time>=last,'Source switch rewound the playhead');
        await pool.sync(p,time,true);last=time;
        if(time>.32&&time<.52)passedGap=true;
        if(time>.65&&time<.95&&!pool.playbackBuffering){const el=elements(pool).get(b.id)!;assert(!el.paused&&Math.abs(time-mediaToTimeline(b,el.currentTime))<.025,'New source and playhead disagree');heardSecond=true;}
        if(time>1.1)break;
      }
      assert(passedGap&&heardSecond&&last>1.05,`Clock got stuck at the old clip end or gap: ${JSON.stringify({passedGap,heardSecond,last,context:pool.context?.state,contextTime:pool.context?.currentTime,players:[...elements(pool).values()].map(e=>({at:e.currentTime,paused:e.paused,seeking:e.seeking,ended:e.ended}))})}`);
    } finally {pool.dispose();URL.revokeObjectURL(asset.url!);}
  });
  await check('Real Timeline drag/release and Preview Play repeatedly resume the final audio position',async()=>{
    const asset=await inspectFile(songFile()),p=newProject();p.assets=[asset];p.clips=[makeClip(asset)];
    const host=document.createElement('div');document.body.appendChild(host);const root=createRoot(host);
    const original=MediaPool.prototype.startPlayback;let current:MediaPool|null=null;
    const capturePool=(pool:MediaPool)=>{current=pool;};
    MediaPool.prototype.startPlayback=function(...args){capturePool(this);return original.apply(this,args);};
    let observed=0;const errors:string[]=[];const error=(message:string)=>errors.push(message);
    const noop=()=>{};
    function Harness() {
      const [time,setTime]=useState(0),[playing,setPlaying]=useState(false);
      observed=time;const seek=(value:number)=>{setPlaying(false);setTime(value);};
      return createElement(Fragment,null,createElement(Preview,{project:p,selection:null,select:noop,time,setTime,seek,playing,setPlaying,dispatch:noop,onError:error}),createElement(Timeline,{project:p,selection:null,select:noop,selected:[],selectMany:noop,time,seek,edit:noop,dispatch:noop,canUndo:false,canRedo:false,split:noop,duplicate:noop,remove:noop,hasClipboard:false,onClipMenuAction:noop,draggingTransition:null,onApplyTransition:noop,onOpenTransitions:noop,ripple:false,setRipple:noop}));
    }
    try {
      root.render(createElement(Harness));await until(()=>!!host.querySelector('[aria-label="Playhead"]'));
      const timeline=host.querySelector<HTMLElement>('.timeline')!,ruler=host.querySelector<HTMLElement>('.ruler')!,content=host.querySelector<HTMLElement>('.timeline-content')!;
      timeline.setPointerCapture=noop;timeline.hasPointerCapture=()=>false;
      const secondTick=ruler.querySelectorAll<HTMLElement>('span')[1];
      const seconds=(secondTick.textContent??'').split(':').reduce((time,part)=>time*60+Number(part),0);
      const pps=parseFloat(secondTick.style.left)/seconds;assert(pps>0,'Missing ruler scale');
      for(const target of [3.1,.5,5.2,2.8]) {
        const x=content.getBoundingClientRect().left,y=ruler.getBoundingClientRect().top+2;
        ruler.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,pointerId:7,clientX:x+.2*pps,clientY:y}));
        timeline.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:7,clientX:x+6*pps,clientY:y}));
        timeline.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:7,clientX:x+target*pps,clientY:y}));
        await until(()=>Math.abs(observed-target)<.025);
        (host.querySelector('[aria-label="Play"]') as HTMLButtonElement).click();
        await until(()=>!!current?.playbackReady);await until(()=>observed>target+.06);
        const pool=current as unknown as MediaPool,el=elements(pool).get(p.clips[0].id)!;
        assert(!el.paused&&Math.abs(observed-el.currentTime)<.06,`UI seek ${target} resumed audio ${el.currentTime} with playhead ${observed}`);
        (host.querySelector('[aria-label="Pause"]') as HTMLButtonElement).click();await until(()=>el.paused);
      }
      assert(errors.length===0,errors.join('; '));
    } finally {root.unmount();host.remove();MediaPool.prototype.startPlayback=original;URL.revokeObjectURL(asset.url!);}
  });
}
