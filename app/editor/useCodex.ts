import { useCallback, useEffect, useLayoutEffect, useRef, useState, type Dispatch } from "react";
import { flushSync } from "react-dom";
import { CODEX_TOOLS, applyCodexEdits, editingCatalog, projectRevision, projectSnapshot, validate } from "./codexEditing";
import type { CodexEvent, CodexStatus, CodexToolRequest, CodexToolResult } from "./codexTypes";
import { dimensions, roundFrame, type Project, type Selection } from "./model";
import { MediaPool } from "./media";
import { Renderer } from "./renderer";
import { FONTS } from "./presets";

type Options = {
  project: Project; ready: boolean; blocked: boolean; time: number;
  selected: NonNullable<Selection>[]; canUndo: boolean; canRedo: boolean;
  edit: (fn: (p: Project) => Project, group?: string) => void;
  dispatch: Dispatch<{ type: "undo" | "redo" }>;
  seek: (time: number) => void; select: (selection: Selection) => void;
  openExport: () => void;
};
export type CodexMessage = { id: string; role: "user" | "assistant"; text: string };
const INITIAL: CodexStatus = { connected: false, needsLogin: false, busy: false, models: [] };
const json = (data: unknown): CodexToolResult => ({ success: true, contentItems: [{ type: "inputText", text: JSON.stringify(data) }] });

export function useCodex(options: Options) {
  const current = useRef(options);
  useLayoutEffect(() => { current.current = options; });
  const [status, setStatus] = useState<CodexStatus>(INITIAL);
  const [messages, setMessages] = useState<CodexMessage[]>([]);
  const [error, setError] = useState("");
  const [activity, setActivity] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [model, setModel] = useState("");
  const sending = useRef(false), gesture = useRef(false), alive = useRef(false);
  const projectId = options.project.id;

  useEffect(() => {
    const native = window.cutlineDesktop;
    if (!native) return;
    alive.current = true;
    const pointerDown = (event: PointerEvent) => {
      gesture.current = !(event.target instanceof Element && event.target.closest(".codex-panel"));
    };
    const pointerUp = () => { gesture.current = false; };
    window.addEventListener("pointerdown", pointerDown);
    window.addEventListener("pointerup", pointerUp);
    window.addEventListener("pointercancel", pointerUp);
    window.addEventListener("blur", pointerUp);
    const stopEvents = native.onCodexEvent((event: CodexEvent) => {
      if (event.type === "status") { setStatus(event); if (!event.busy) setActivity(""); }
      if (event.type === "error") { setError(event.message); setActivity(""); }
      if (event.type === "setup") setActivity(event.message);
      if (event.type === "tool") {
        const labels: Record<string, string> = {
          cutline_get_project: "Reading the timeline", cutline_get_catalog: "Checking available styles",
          cutline_apply_edits: "Editing your project", cutline_preview: "Checking the preview",
          cutline_history: "Updating edit history", cutline_open_export: "Opening export",
        };
        setActivity(event.status === "working" ? (labels[event.name] ?? "Working") : "Thinking…");
      }
      if (event.type === "message") setMessages((previous) => {
        const existing = previous.find((message) => message.id === event.id && message.role === "assistant");
        const text = event.text !== undefined ? event.text : (existing?.text ?? "") + (event.delta ?? "");
        if (existing) return previous.map((message) => message === existing ? { ...message, text } : message);
        return [...previous, { id: event.id, role: "assistant", text }];
      });
    });
    const stopTools = native.onCodexTool(async (request: CodexToolRequest): Promise<CodexToolResult> => {
      const active = async () => {
        if (!alive.current || !await native.codexToolActive(request.id)) throw new Error("Editing cancelled.");
      };
      await active();
      const initial = current.current;
      if (request.projectId !== initial.project.id) throw new Error("The open project changed. Start a new request for the current project.");
      if (!initial.ready || initial.blocked) throw new Error("The editor is busy importing, exporting, or loading a project. Wait and retry.");
      const schema = CODEX_TOOLS.find((tool) => tool.name === request.name)?.inputSchema;
      if (!schema) throw new Error("Unknown editing tool.");
      validate(request.args, schema);
      if (request.name === "cutline_get_project") return json({ ...projectSnapshot(initial.project), playhead: initial.time, selected: initial.selected, canUndo: initial.canUndo, canRedo: initial.canRedo });
      if (request.name === "cutline_get_catalog") {
        const fonts = await native.listInstalledFonts().catch(() => []);
        await active();
        return json(editingCatalog([...new Set([...FONTS, ...fonts])]));
      }
      if (request.name === "cutline_apply_edits") {
        if (gesture.current) throw new Error("A manual edit is in progress. Wait until the mouse is released and read the project again.");
        const result = applyCodexEdits(initial.project, request.args);
        flushSync(() => initial.edit((project) => project === initial.project ? result.project : project));
        if (current.current.project !== result.project) throw new Error("The project changed. Read get_project again.");
        const changed = result.result.changes.map((change) => change.id).filter(Boolean).at(-1);
        const item = result.project.clips.find((clip) => clip.id === changed) ?? result.project.texts.find((text) => text.id === changed);
        if (item) { current.current.select({ id: item.id, kind: "sourceEnd" in item ? "clip" : "text" }); current.current.seek(item.start); }
        else if (initial.selected.some((selection) => ![...result.project.clips, ...result.project.texts].some((item) => item.id === selection.id))) current.current.select(null);
        return json(result.result);
      }
      if (request.name === "cutline_history") {
        if (gesture.current) throw new Error("Finish the manual edit before changing history.");
        const action = (request.args as { action: "undo" | "redo" }).action;
        if (!(action === "undo" ? initial.canUndo : initial.canRedo)) throw new Error("Nothing to " + action + ".");
        flushSync(() => { initial.dispatch({ type: action }); initial.select(null); });
        return json(projectSnapshot(current.current.project));
      }
      if (request.name === "cutline_open_export") {
        if (!initial.project.clips.length && !initial.project.texts.length) throw new Error("The timeline is empty.");
        initial.openExport();
        return json({ opened: true, message: "Export settings are open. The user chooses format, resolution and save location." });
      }
      const project = initial.project, revision = projectRevision(project);
      const time = roundFrame((request.args as { time: number }).time, project.fps);
      const pool = new MediaPool();
      try {
        await pool.ensure(project);
        await pool.sync(project, time, false);
        // MediaPool also prepares text fonts, matching editor preview/export.
        await active();
        if (projectRevision(current.current.project) !== revision) throw new Error("The project changed during preview. Read it again before verifying.");
        const canvas = document.createElement("canvas");
        const size = dimensions(project.ratio, 540);
        canvas.width = size.width; canvas.height = size.height;
        new Renderer().draw(canvas, project, time, pool.sources);
        current.current.seek(time);
        return { success: true, contentItems: [{ type: "inputText", text: JSON.stringify({ projectId: project.id, revision, time, width: canvas.width, height: canvas.height }) }, { type: "inputImage", imageUrl: canvas.toDataURL("image/jpeg", 0.86) }] };
      } finally { pool.dispose(); }
    });
    void native.codexStatus().then(setStatus).catch(() => {});
    return () => {
      alive.current = false; stopEvents(); stopTools();
      window.removeEventListener("pointerdown", pointerDown);
      window.removeEventListener("pointerup", pointerUp);
      window.removeEventListener("pointercancel", pointerUp);
      window.removeEventListener("blur", pointerUp);
    };
  }, []);
  useEffect(() => {
    // Switching projects must never retain a pending request for the old timeline.
    const native = window.cutlineDesktop;
    if (!native) return;
    void native.codexStatus().then(async (state) => {
      if (state.busy) await native.codexStop();
      await native.codexReset();
      if (alive.current) { setMessages([]); setError(""); }
    }).catch(() => {});
  }, [projectId]);
  const connect = useCallback(async () => {
    const native = window.cutlineDesktop;
    if (!native || connecting) return;
    setConnecting(true); setError(""); setActivity("Connecting to Codex…");
    try { setStatus(await native.codexConnect(CODEX_TOOLS)); }
    catch (error) { setError((error as Error).message); }
    finally { setConnecting(false); setActivity(""); }
  }, [connecting]);
  const login = async () => {
    setError("");
    try { await window.cutlineDesktop?.codexLogin(); setActivity("Finish signing in in your browser…"); }
    catch (error) { setError((error as Error).message); }
  };
  const send = async (prompt: string) => {
    const native = window.cutlineDesktop;
    if (!native || sending.current || status.busy || !prompt.trim()) return false;
    sending.current = true; setError(""); setActivity("Thinking…");
    const id = crypto.randomUUID();
    setMessages((previous) => [...previous, { id, role: "user", text: prompt.trim() }]);
    try { await native.codexSend(prompt, current.current.project.id, status.models.some((value) => value.id === model) ? model : undefined); return true; }
    catch (error) { setError((error as Error).message); setActivity(""); return false; }
    finally { sending.current = false; }
  };
  const stop = async () => {
    try { await window.cutlineDesktop?.codexStop(); setActivity(""); }
    catch (error) { setError((error as Error).message); }
  };
  const reset = async () => {
    try { await window.cutlineDesktop?.codexReset(); setMessages([]); setError(""); }
    catch (error) { setError((error as Error).message); }
  };
  const disconnect = async () => {
    try { await window.cutlineDesktop?.codexDisconnect(); setActivity(""); }
    catch (error) { setError((error as Error).message); }
  };
  return { status, messages, error, activity, connecting, model, setModel, connect, login, send, stop, reset, disconnect };
}
