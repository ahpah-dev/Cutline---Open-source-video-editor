import {build} from 'vite';
import {spawn} from 'node:child_process';
import electron from 'electron';
await build({configFile:false,logLevel:'warn',build:{outDir:'work/text-font-tests',emptyOutDir:true,lib:{entry:'tests/text-fonts-entry.ts',formats:['iife'],name:'TextFontTests',fileName:()=> 'fonts.js'}}});
const child=spawn(electron,['tests/text-fonts-main.cjs'],{stdio:'inherit',windowsHide:true});
child.on('exit',code=>{process.exitCode=code??1});
