/* Local, bounded data-URL references cannot use a remote image optimizer. */
/* eslint-disable @next/next/no-img-element */
import { useEffect, useRef, useState } from "react";
import { ArrowUp, Check, ImagePlus, LoaderCircle, MessageSquare, PlugZap, RotateCcw, Square, Unplug, X } from "lucide-react";
import type { useCodex } from "./useCodex";
import type { CodexImage } from "./codexTypes";
import { referenceImage, SPEECH_MODELS } from "./codexMedia";
import { CustomAPIForm } from "./CustomAPIForm";

type Props = { codex: ReturnType<typeof useCodex>; desktop: boolean; ready: boolean; canUndo: boolean; undo: () => void; close: () => void };
const EXAMPLES = ["Add a title with Letter Pop In", "Give the selected clip a slow zoom", "Make a clean 15-second edit"];
export function CodexPanel({ codex, desktop, ready, canUndo, undo, close }: Props) {
  const [prompt, setPrompt] = useState("");
  const [chosenProvider,setProvider] = useState<"codex"|"custom">(codex.status.provider || "codex");
  const [submitting, setSubmitting] = useState(false);
  const [attachments, setAttachments] = useState<{ projectId: string; images: CodexImage[] }>({ projectId: codex.projectId, images: [] });
  const [attaching, setAttaching] = useState(false), [attachmentError, setAttachmentError] = useState("");
  const images = attachments.projectId === codex.projectId ? attachments.images : [];
  const files = useRef<HTMLInputElement>(null), attachmentAbort = useRef<AbortController | null>(null);
  const bottom = useRef<HTMLDivElement>(null), input = useRef<HTMLTextAreaElement>(null);
  const { status, messages, activity, error, connecting } = codex;
  const provider = status.connected ? status.provider || "codex" : chosenProvider;
  const assistant = status.provider === "custom" ? status.providerName || "Custom API" : "Codex";
  const working = status.busy || submitting;
  const imagesAllowed = codex.mediaEnabled && (!codex.activeModel?.inputModalities || codex.activeModel.inputModalities.includes("image"));
  const modelsAvailable = status.models.length > 0;
  useEffect(() => { bottom.current?.scrollIntoView({ block: "end" }); }, [messages, activity]);
  useEffect(() => () => { attachmentAbort.current?.abort(); }, [codex.projectId]);
  const attach = async (selected: FileList | null) => {
    if (!selected?.length || working || attaching || !imagesAllowed) return;
    const chosen = Array.from(selected);
    if (chosen.length + images.length > 3) { setAttachmentError("Attach up to 3 reference images per message."); return; }
    const controller = new AbortController(); attachmentAbort.current?.abort(); attachmentAbort.current = controller;
    const projectId = codex.projectId;
    setAttaching(true); setAttachmentError("");
    try {
      const added = [];
      for (const file of chosen) added.push(await referenceImage(file, controller.signal));
      if (!controller.signal.aborted) setAttachments({ projectId, images: [...images, ...added] });
    } catch (error) { if (!controller.signal.aborted) setAttachmentError((error as Error).message); }
    finally { if (attachmentAbort.current === controller) { attachmentAbort.current = null; setAttaching(false); } }
  };
  const submit = async () => {
    if (working || attaching || !modelsAvailable || !prompt.trim() || (images.length > 0 && !imagesAllowed)) return;
    const value = prompt; setPrompt(""); setSubmitting(true);
    try { if (!await codex.send(value, images)) setPrompt(value); else setAttachments({ projectId: codex.projectId, images: [] }); }
    finally { setSubmitting(false); input.current?.focus(); }
  };
  return <aside className={"codex-panel" + (provider === "custom" && !status.connected ? " custom-api-disconnected" : "")} aria-label="AI video assistant">
    <header className="codex-panel-header">
      <span className="codex-mark"><MessageSquare size={16} /></span>
      <div><strong>AI editor</strong><span>Your video, in your words</span></div>
      <button type="button" className="icon-button" aria-label="Close Codex panel" title="Back to inspector" onClick={close}><X size={16} /></button>
    </header>
    {desktop && <label className="ai-provider">Connect with<select aria-label="AI provider" value={provider} disabled={connecting || status.connected || status.busy} onChange={event=>setProvider(event.target.value as "codex"|"custom")}><option value="codex">Codex · account sign-in</option><option value="custom">Custom API · 9Router & more</option></select></label>}
    {desktop && provider === "custom" && <CustomAPIForm codex={codex} />}
    {!desktop ? <div className="codex-setup"><h3>Made for the PC app</h3><p>Open Cutline on Windows to connect Codex or a custom API and edit your timeline from this panel.</p></div>
      : (!status.connected || status.needsLogin) && provider === "custom" ? <div className="codex-setup custom-api-welcome"><h3>Your models. Your edit.</h3><p>Configure your endpoint above. The assistant uses the same precise, undoable timeline tools as Codex.</p></div>
      : !status.connected || status.needsLogin ? <div className="codex-setup">
        <div className="codex-orb"><PlugZap size={28} /></div>
        <h3>Describe it. Edit it.</h3>
        <p>Connect your Codex account, then ask for cuts, titles, animations, effects and more — right on your timeline.</p>
        <ol><li><Check size={14} /> No API key or terminal setup</li><li><Check size={14} /> Exact clip and frame controls</li><li><Check size={14} /> Every edit batch can be undone</li></ol>
        <button type="button" className="button primary codex-connect" disabled={connecting} onClick={() => void (status.needsLogin ? codex.login() : codex.connect())}>
          {connecting ? <LoaderCircle className="spin" size={16} /> : <PlugZap size={16} />}
          {connecting ? "Connecting…" : status.needsLogin ? "Sign in to Codex" : "Connect Codex"}
        </button>
        <small>Uses your Codex account and plan. Existing sign-in is reused. Connect may download the official runtime. Requested images, transcripts and analysis metadata are sent to Codex. Raw audio and original media files stay local.</small>
      </div> : <>
        <div className="codex-session">
          <span className="codex-connected"><i /> {assistant} {status.account?.planType ? `· ${status.account.planType}` : ""}</span>
          <button type="button" className="icon-button" title="New chat" aria-label="Start a new Codex chat" disabled={working} onClick={() => void codex.reset()}><RotateCcw size={14} /></button>
          <button type="button" className="icon-button" title="Disconnect" aria-label="Disconnect Codex" onClick={() => void codex.disconnect()}><Unplug size={14} /></button>
        </div>
        <div className="codex-messages">
        <details className="codex-media-access">
          <summary>Media access <span>{codex.mediaEnabled ? "Images + local analysis" : "Off"}</span></summary>
          <label><input type="checkbox" checked={codex.mediaEnabled} onChange={event => codex.setMediaEnabled(event.target.checked)} /> Allow requested images and rhythm analysis</label>
          <p>{assistant} can inspect frames when the model supports images. Rhythm, level and silence analysis runs locally. Requested frames and analysis results are shared with your connected provider; raw audio is not.</p>
          <label><input type="checkbox" checked={codex.speechEnabled} disabled={!codex.mediaEnabled} onChange={event => codex.setSpeechEnabled(event.target.checked)} /> Enable local Whisper speech analysis</label>
          <select aria-label="Local speech model" value={codex.speechModel} disabled={working || !codex.mediaEnabled} onChange={event => codex.setSpeechModel(event.target.value)}>{SPEECH_MODELS.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</select>
          <p>Enabling authorizes a one-time model download on the first speech request ({SPEECH_MODELS.find(model => model.id === codex.speechModel)?.size}). Transcripts and timing are shared with your connected provider. Recognition can make mistakes. This is not native audio hearing.</p>
        </details>
          {!messages.length && <div className="codex-welcome"><h3>What are we making?</h3><p>Import your media, then tell {assistant} what you want. It can read the timeline, your selection and the playhead.</p><div className="codex-examples">{EXAMPLES.map((example) => <button key={example} type="button" onClick={() => { setPrompt(example); input.current?.focus(); }}>{example}<ArrowUp size={13} /></button>)}</div></div>}
          {messages.map((message) => <div key={message.id} className={`codex-message ${message.role}`}><span>{message.role === "user" ? "You" : assistant}</span><p>{message.text}</p>{!!message.images?.length && <div className="codex-reference-list">{message.images.map((image, index) => <figure key={index}><img src={image.imageUrl} alt={`Reference: ${image.name}`} /><figcaption>{image.name}</figcaption></figure>)}</div>}</div>)}
          {working && <div className="codex-working" role="status"><LoaderCircle className="spin" size={14} /> {activity || "Thinking…"}</div>}
          <div ref={bottom} />
        </div>
        <form className="codex-composer" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          {!modelsAvailable && <div role="alert"><p>{provider === "custom" ? "No API models available. Disconnect and enter an exact model ID." : "No supported models were returned for this account. GPT-5.6 and GPT-5.5 are no longer offered."}</p>{provider === "codex" && <button type="button" className="button" disabled={connecting} onClick={() => void codex.connect()}>Refresh models</button>}</div>}
          <input ref={files} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/bmp,image/avif" multiple hidden onChange={event => { void attach(event.target.files); event.target.value = ""; }} />
          {!!images.length && <div className="codex-reference-list pending">{images.map((image, index) => <figure key={index}><img src={image.imageUrl} alt={`Reference: ${image.name}`} /><figcaption>{image.name}</figcaption><button type="button" aria-label={`Remove reference ${image.name}`} disabled={working} onClick={() => setAttachments({ projectId: codex.projectId, images: images.filter((_, i) => i !== index) })}><X size={12} /></button></figure>)}</div>}
          {attachmentError && <p className="codex-attachment-error" role="alert">{attachmentError}</p>}
          <textarea ref={input} aria-label="Describe your video edit" value={prompt} maxLength={20000} placeholder={`Tell ${assistant} how to edit your video…`} onChange={(event) => setPrompt(event.target.value)} disabled={!ready || !modelsAvailable} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }} />
          <div className="codex-composer-tools">
            <select aria-label="Codex model" value={status.models.some((model) => model.id === codex.model) ? codex.model : ""} disabled={working || !modelsAvailable} onChange={(event) => codex.setModel(event.target.value)}><option value="">{modelsAvailable ? `Default · ${(status.models.find((model) => model.isDefault) || status.models[0]).name}` : "No available models"}</option>{status.models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</select>
            <button type="button" className="icon-button" aria-label="Attach reference images" title="Attach up to 3 reference images (not imported into the project)" disabled={working || attaching || !imagesAllowed || images.length >= 3} onClick={() => files.current?.click()}>{attaching ? <LoaderCircle className="spin" size={15} /> : <ImagePlus size={16} />}</button>
            {working ? <button type="button" className="codex-send" aria-label="Stop Codex edit" title="Stop" onClick={() => void codex.stop()}><Square size={14} /></button> : <button type="submit" className="codex-send" aria-label="Send edit to Codex" disabled={!ready || attaching || !modelsAvailable || !prompt.trim() || (images.length > 0 && !imagesAllowed)} title="Send · Enter"><ArrowUp size={18} /></button>}
          </div>
          <label className="codex-effort">Reasoning effort<select aria-label="Codex reasoning effort" value={codex.effort} disabled={working || !modelsAvailable} onChange={event => codex.setEffort(event.target.value)}><option value="">Auto{codex.activeModel?.defaultEffort ? ` · ${codex.activeModel.defaultEffort}` : " · model default"}</option>{codex.activeModel?.reasoningEfforts?.map(effort => <option key={effort.id} value={effort.id} title={effort.description}>{effort.id.charAt(0).toUpperCase() + effort.id.slice(1)}</option>)}</select></label>
          <div className="codex-composer-footer"><span>{status.account?.type === "customAPI" ? "Your API provider may charge for requests" : status.account?.type === "apiKey" ? "Using existing API-key sign-in · API charges apply" : "Enter to send · Shift+Enter for a new line"}</span><button type="button" disabled={!canUndo || working} onClick={undo} title="Undo the last edit"><RotateCcw size={12} /> Undo</button></div>
        </form>
      </>}
    {activity && !status.connected && <div className="codex-working" role="status"><LoaderCircle className="spin" size={14} /> {activity}</div>}
    {error && <div className="codex-error" role="alert">{error}{provider === "codex" && <button type="button" disabled={connecting || working} onClick={() => void codex.connect()}>Reconnect</button>}</div>}
  </aside>;
}
