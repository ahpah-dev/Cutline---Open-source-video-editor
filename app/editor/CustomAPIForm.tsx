import { useEffect, useState } from "react";
import type { useCodex } from "./useCodex";
import type { CustomAPISettings } from "./codexTypes";

const INITIAL:CustomAPISettings = {name:"9Router",baseURL:"http://localhost:20128/v1",model:"",images:false,reasoning:false,hasKey:false,encryptionAvailable:false};
export function CustomAPIForm({codex}:{codex:ReturnType<typeof useCodex>}) {
  const [settings,setSettings] = useState(INITIAL), [key,setKey] = useState("");
  const [loaded,setLoaded] = useState(false), [error,setError] = useState("");
  const [remember,setRemember] = useState(true), [forgetting,setForgetting] = useState(false);
  const locked = codex.connecting || codex.status.connected || codex.status.busy || forgetting;
  useEffect(()=>{
    let alive = true;
    void window.cutlineDesktop?.apiSettings().then(value=>{if(alive){setSettings(value);setRemember(value.encryptionAvailable);setLoaded(true);}}).catch(()=>{if(alive){setError("Saved connection could not be read. Use Forget connection to reset it.");setLoaded(true);}});
    return ()=>{alive=false;};
  },[]);
  const connect = async () => {
    setError("");
    const connected = await codex.connect({provider:"custom",...settings,apiKey:key ? key : settings.hasKey ? undefined : "",rememberKey:remember});
    if (connected) {
      setKey("");
      try { setSettings(await window.cutlineDesktop!.apiSettings()); }
      catch { setError("Connected, but saved settings could not be read."); }
    }
  };
  const forget = async () => {
    setForgetting(true);setError("");setKey("");
    try { setSettings(await window.cutlineDesktop!.forgetAPI()); await codex.reset(); }
    catch { setError("Could not forget the saved connection. Disconnect and try again."); }
    finally {setForgetting(false);}
  };
  return <details className="custom-api-settings" open={!codex.status.connected}>
    <summary>API connection <span>{codex.status.connected ? settings.name : "OpenAI-compatible"}</span></summary>
    <div className="custom-api-fields">
      <p>Connect 9Router or any API with OpenAI-compatible Chat Completions and tool calling.</p>
      <fieldset disabled={locked || !loaded}>
        <label>Quick setup<select aria-label="API preset" value={settings.name === "9Router" && settings.baseURL === INITIAL.baseURL ? "9router" : "custom"} onChange={event=>{if(event.target.value === "9router"){setSettings({...INITIAL,encryptionAvailable:settings.encryptionAvailable});setKey("");}else setSettings({...settings,name:"Custom API"});}}><option value="9router">9Router · local</option><option value="custom">Custom endpoint</option></select></label>
        <label>Connection name<input aria-label="API connection name" maxLength={80} value={settings.name} onChange={event=>setSettings({...settings,name:event.target.value})} /></label>
        <label>API base URL<input aria-label="API base URL" type="url" spellCheck={false} autoComplete="off" maxLength={2000} placeholder="https://your-provider.example/v1" value={settings.baseURL} onChange={event=>{setKey("");setSettings({...settings,baseURL:event.target.value,hasKey:false});}} /></label>
        <label>API key <span>{settings.hasKey ? "Saved securely on this PC" : "Optional for keyless local servers"}</span><input aria-label="API key" type="password" autoComplete="new-password" spellCheck={false} maxLength={8192} value={key} placeholder={settings.hasKey ? "Leave blank to use saved key" : "Paste key from your provider dashboard"} onChange={event=>setKey(event.target.value)} /></label>
        {settings.hasKey && <button type="button" className="button secondary" onClick={()=>{setKey("");setSettings({...settings,hasKey:false});}}>Remove saved key on next connect</button>}
        <label className="custom-api-check"><input type="checkbox" checked={remember} disabled={!settings.encryptionAvailable} onChange={event=>setRemember(event.target.checked)} /> Remember key with Windows encryption</label>
        <label>Model or router combo ID<input aria-label="API model ID" spellCheck={false} autoComplete="off" maxLength={200} placeholder="Leave blank to discover models" value={settings.model} onChange={event=>setSettings({...settings,model:event.target.value})} /></label>
        <small>Use the exact ID from your provider. Discovery makes a GET /models request, not a paid chat request. Manual IDs are verified on your first message.</small>
        <label className="custom-api-check"><input type="checkbox" checked={settings.images} onChange={event=>setSettings({...settings,images:event.target.checked})} /> Model supports image input</label>
        <label className="custom-api-check"><input type="checkbox" checked={settings.reasoning} onChange={event=>setSettings({...settings,reasoning:event.target.checked})} /> API supports reasoning_effort</label>
        <small>Enable capabilities only if supported by your selected model. Auto sends no reasoning parameter.</small>
        <button type="button" className="button primary codex-connect" onClick={()=>void connect()}>{codex.connecting ? "Connecting…" : settings.model.trim() ? "Connect custom API" : "Discover models & connect"}</button>
      </fieldset>
      {codex.status.connected && <small>Disconnect below to change endpoint or capabilities.</small>}
      <p className="custom-api-notice">Prompts, project metadata and permitted frames/analysis go to this endpoint and any provider behind your router. Provider fees may apply; Cutline adds no charge. Keys are not included in projects or backups.</p>
      <button type="button" className="custom-api-forget" disabled={codex.connecting || codex.status.busy || forgetting} onClick={()=>void forget()}>{forgetting ? "Forgetting…" : "Forget connection & saved key"}</button>
      {error && <p role="alert">{error}</p>}
    </div>
  </details>;
}
