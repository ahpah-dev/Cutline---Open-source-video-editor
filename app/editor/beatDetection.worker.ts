import { analyzeBeats } from "./beatDetection";
self.onmessage=(event:MessageEvent<{samples:Float32Array}>)=>{
  try{const result=analyzeBeats(event.data.samples,16000,value=>self.postMessage({type:"progress",value}));self.postMessage({type:"result",result},{transfer:[result.envelope.buffer as ArrayBuffer,result.energy.buffer as ArrayBuffer]});}
  catch(error){self.postMessage({type:"error",message:(error as Error).message});}
};
