import { build } from "vite";
import {readFile} from "node:fs/promises";
import path from "node:path";
await build({
  configFile:false, logLevel:"warn", publicDir:false,
  plugins:[{name:"native-license-notices",async generateBundle(_options,bundle){
    const roots=new Set();
    for(const chunk of Object.values(bundle)) if(chunk.type === "chunk") for(const id of Object.keys(chunk.modules)) {
      const matches=[...id.matchAll(/[\\/]node_modules[\\/](?:@[^\\/]+[\\/])?[^\\/]+/g)];
      const match=matches.at(-1);if(match)roots.add(id.slice(0,match.index+match[0].length));
    }
    const notices=[];
    for(const root of [...roots].sort()){
      const pkg=JSON.parse(await readFile(path.join(root,"package.json"),"utf8"));
      let license;
      for(const name of ["LICENSE","LICENSE.md","LICENSE.txt","LICENSE-MIT","license"]){try{license=await readFile(path.join(root,name),"utf8");break;}catch{/* Try the published license filename. */}}
      // These same-repository SDK packages omit LICENSE from their npm files.
      if(!license && pkg.name.startsWith("@ai-sdk/") && pkg.license === "Apache-2.0") license=await readFile("node_modules/ai/LICENSE","utf8");
      if(!license)throw new Error("Missing native dependency license: "+pkg.name);
      notices.push(`${pkg.name} ${pkg.version} (${pkg.license})\n${license}`);
    }
    this.emitFile({type:"asset",fileName:"LICENSES.txt",source:notices.join("\n\n----------------------------------------\n\n") + "\n\n" + await readFile("public/licenses/Apache-2.0.txt","utf8")});
  }}],
  build:{outDir:"dist-native",emptyOutDir:true,target:"node22",minify:true,
    lib:{entry:"electron/custom-api.mts",formats:["es"],fileName:()=>"custom-api.mjs"},
    rollupOptions:{external:/^node:/},
  },
});
