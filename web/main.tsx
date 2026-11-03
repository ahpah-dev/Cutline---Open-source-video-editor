import { Component, useEffect, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import Editor from "../app/Editor";
import "../app/globals.css";
import "../app/editor/themes.css";
import "./web.css";
import { applyTheme, savedTheme } from "../app/editor/themes";

const downloads = "https://github.com/ahpah-dev/Cutline---Open-source-video-editor/releases/latest";
const welcomeKey = "cutline.webWelcome.v1";
applyTheme(savedTheme());

class EditorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return <main className="web-error"><h1>Cutline couldn’t open this workspace.</h1><p>Try the latest Chrome or Edge on a computer. Reloading does not clear your saved projects; don’t clear browser storage unless you have a backup.</p><button className="button primary" onClick={() => location.reload()}>Reload editor</button><a href={downloads}>Get the Windows app</a></main>;
    return this.props.children;
  }
}

function WebWelcome() {
  const [visible, setVisible] = useState(() => {
    try { return localStorage.getItem(welcomeKey) !== "seen"; } catch { return true; }
  });
  const dialog = useRef<HTMLDialogElement>(null);
  const start = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (visible) { dialog.current?.showModal(); start.current?.focus(); } }, [visible]);
  const dismiss = () => {
    try { localStorage.setItem(welcomeKey, "seen"); } catch { /* Editing does not require preference storage. */ }
    setVisible(false);
  };
  if (!visible) return null;
  return <dialog ref={dialog} className="web-welcome" aria-labelledby="web-welcome-title" onCancel={dismiss}>
    <span className="web-edition">CUTLINE / WEB EDITOR</span>
    <h1 id="web-welcome-title">Your browser. Your studio.</h1>
    <p>Edit videos, layer text, add effects and export without a watermark. No installation or account needed.</p>
    <ul><li><strong>Your files stay on this device.</strong> Editing and exports run locally, not on GitHub’s servers.</li><li><strong>Keep a backup.</strong> Projects save in this browser only. Use Backup to move them between browsers or the Windows app. Clearing site data can delete projects.</li><li><strong>Use Chrome or Edge on a computer.</strong> Export formats depend on browser codecs. Long exports need enough memory; the Windows app supports disk-backed exports.</li><li><strong>AI connections need the Windows app.</strong> Whisper and object detection download their models on demand; Large Whisper needs WebGPU.</li></ul>
    <div className="web-welcome-actions"><button ref={start} className="button primary" onClick={dismiss}>Open editor</button><a href={downloads} target="_blank" rel="noopener noreferrer">Windows app ↗</a></div>
  </dialog>;
}

const root = document.getElementById("root");
if (!root) throw new Error("Cutline could not create its browser workspace.");
createRoot(root).render(<EditorBoundary><Editor /><WebWelcome /></EditorBoundary>);
