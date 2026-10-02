import { useEffect, useRef, useState } from "react";
import { ArrowUp, Check, LoaderCircle, MessageSquare, PlugZap, RotateCcw, Square, Unplug, X } from "lucide-react";
import type { useCodex } from "./useCodex";

type Props = { codex: ReturnType<typeof useCodex>; desktop: boolean; ready: boolean; canUndo: boolean; undo: () => void; close: () => void };
const EXAMPLES = ["Add a title with Letter Pop In", "Give the selected clip a slow zoom", "Make a clean 15-second edit"];
export function CodexPanel({ codex, desktop, ready, canUndo, undo, close }: Props) {
  const [prompt, setPrompt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const bottom = useRef<HTMLDivElement>(null), input = useRef<HTMLTextAreaElement>(null);
  const { status, messages, activity, error, connecting } = codex;
  const working = status.busy || submitting;
  useEffect(() => { bottom.current?.scrollIntoView({ block: "end" }); }, [messages, activity]);
  const submit = async () => {
    if (working || !prompt.trim()) return;
    const value = prompt; setPrompt(""); setSubmitting(true);
    try { if (!await codex.send(value)) setPrompt(value); }
    finally { setSubmitting(false); input.current?.focus(); }
  };
  return <aside className="codex-panel" aria-label="Codex video assistant">
    <header className="codex-panel-header">
      <span className="codex-mark"><MessageSquare size={16} /></span>
      <div><strong>Codex</strong><span>Your video, in your words</span></div>
      <button type="button" className="icon-button" aria-label="Close Codex panel" title="Back to inspector" onClick={close}><X size={16} /></button>
    </header>
    {!desktop ? <div className="codex-setup"><h3>Made for the PC app</h3><p>Open Cutline on Windows to connect Codex and edit your timeline from this panel.</p></div>
      : !status.connected || status.needsLogin ? <div className="codex-setup">
        <div className="codex-orb"><PlugZap size={28} /></div>
        <h3>Describe it. Edit it.</h3>
        <p>Connect your Codex account, then ask for cuts, titles, animations, effects and more — right on your timeline.</p>
        <ol><li><Check size={14} /> No API key or terminal setup</li><li><Check size={14} /> Exact clip and frame controls</li><li><Check size={14} /> Every edit batch can be undone</li></ol>
        <button type="button" className="button primary codex-connect" disabled={connecting} onClick={() => void (status.needsLogin ? codex.login() : codex.connect())}>
          {connecting ? <LoaderCircle className="spin" size={16} /> : <PlugZap size={16} />}
          {connecting ? "Connecting…" : status.needsLogin ? "Sign in to Codex" : "Connect Codex"}
        </button>
        <small>Uses your Codex account and plan. Existing sign-in is reused. If needed, Connect downloads the official Codex runtime once (~325 MB installed). Project metadata and requested preview frames are sent to Codex; original media files stay local.</small>
      </div> : <>
        <div className="codex-session">
          <span className="codex-connected"><i /> Connected {status.account?.planType ? `· ${status.account.planType}` : ""}</span>
          <button type="button" className="icon-button" title="New chat" aria-label="Start a new Codex chat" disabled={working} onClick={() => void codex.reset()}><RotateCcw size={14} /></button>
          <button type="button" className="icon-button" title="Disconnect" aria-label="Disconnect Codex" onClick={() => void codex.disconnect()}><Unplug size={14} /></button>
        </div>
        <div className="codex-messages">
          {!messages.length && <div className="codex-welcome"><h3>What are we making?</h3><p>Import your media, then tell Codex what you want. It can see the timeline, your selection and the playhead.</p><div className="codex-examples">{EXAMPLES.map((example) => <button key={example} type="button" onClick={() => { setPrompt(example); input.current?.focus(); }}>{example}<ArrowUp size={13} /></button>)}</div></div>}
          {messages.map((message) => <div key={message.id} className={`codex-message ${message.role}`}><span>{message.role === "user" ? "You" : "Codex"}</span><p>{message.text}</p></div>)}
          {working && <div className="codex-working" role="status"><LoaderCircle className="spin" size={14} /> {activity || "Thinking…"}</div>}
          <div ref={bottom} />
        </div>
        <form className="codex-composer" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <textarea ref={input} aria-label="Describe your video edit" value={prompt} maxLength={20000} placeholder="Tell Codex how to edit your video…" onChange={(event) => setPrompt(event.target.value)} disabled={!ready} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }} />
          <div className="codex-composer-tools">
            <select aria-label="Codex model" value={codex.model} disabled={working} onChange={(event) => codex.setModel(event.target.value)}><option value="">Default model</option>{status.models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</select>
            {working ? <button type="button" className="codex-send" aria-label="Stop Codex edit" title="Stop" onClick={() => void codex.stop()}><Square size={14} /></button> : <button type="submit" className="codex-send" aria-label="Send edit to Codex" disabled={!ready || !prompt.trim()} title="Send · Enter"><ArrowUp size={18} /></button>}
          </div>
          <div className="codex-composer-footer"><span>{status.account?.type === "apiKey" ? "Using existing API-key sign-in · API charges apply" : "Enter to send · Shift+Enter for a new line"}</span><button type="button" disabled={!canUndo || working} onClick={undo} title="Undo the last edit"><RotateCcw size={12} /> Undo</button></div>
        </form>
      </>}
    {activity && !status.connected && <div className="codex-working" role="status"><LoaderCircle className="spin" size={14} /> {activity}</div>}
    {error && <div className="codex-error" role="alert">{error}<button type="button" disabled={connecting || working} onClick={() => void codex.connect()}>Reconnect</button></div>}
  </aside>;
}
