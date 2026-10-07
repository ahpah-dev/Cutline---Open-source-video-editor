const {app,BrowserWindow}=require('electron');
const {readFile}=require('node:fs/promises');
const path=require('node:path');
app.setPath('userData',path.resolve('work/text-font-profile'));
app.whenReady().then(async()=>{
  const win=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  const timer=setTimeout(()=>app.exit(1),30000);
  try{
    await win.loadFile(path.resolve('tests/engine.html'));
    await win.webContents.executeJavaScript(await readFile('work/text-font-tests/fonts.js','utf8'));
    const result=await win.webContents.executeJavaScript('runTextFontTests()');console.log(JSON.stringify(result,null,2));
    clearTimeout(timer);app.exit(result.failures.length?1:0);
  }catch(e){console.error(e);clearTimeout(timer);app.exit(1)}
});
