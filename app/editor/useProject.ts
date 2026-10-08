import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import {
  loadProject,
  saveProject,
  saveMediaAsset,
  deleteSavedProject,
  type PersistedMedia,
  type PersistedProject,
  type PersistedAsset,
} from "../editorStorage";
import {
  migrateProject,
  newProject,
  uid,
  type Asset,
  type Project,
} from "./model";
import { analyzeAudioWaveform, type WaveformData } from "./waveform";

type History = {
  project: Project;
  past: Project[];
  future: Project[];
  origin: Project | null;
  group: string;
  at: number;
};
type Action =
  | { type: "edit"; fn: (p: Project) => Project; group: string; at: number }
  | { type: "preview"; fn: (p: Project) => Project }
  | { type: "begin" | "commit" | "cancel" | "undo" | "redo" }
  | { type: "waveform"; id: string; data: WaveformData }
  | { type: "load"; project: Project };
export function historyReducer(s: History, a: Action): History {
  switch (a.type) {
    case "waveform": {
      if (!s.project.assets.some((asset) => asset.id === a.id)) return s;
      const update = (project: Project): Project => ({
        ...project,
        assets: project.assets.map((asset) => asset.id === a.id ? { ...asset, ...a.data } : asset),
      });
      // Analysis is asset metadata, not a user edit. Undo must not erase it.
      return {
        ...s,
        project: update(s.project),
        past: s.past.map(update),
        future: s.future.map(update),
        origin: s.origin && update(s.origin),
      };
    }
    case "load":
      return {
        project: a.project,
        past: [],
        future: [],
        origin: null,
        group: "",
        at: 0,
      };
    case "begin":
      return s.origin ? s : { ...s, origin: s.project };
    case "preview":
      return { ...s, project: a.fn(s.project) };
    case "cancel":
      return { ...s, project: s.origin ?? s.project, origin: null };
    case "commit":
      return s.origin && s.origin !== s.project
        ? {
            ...s,
            past: [...s.past, s.origin].slice(-80),
            future: [],
            origin: null,
            group: "",
          }
        : { ...s, origin: null };
    case "edit": {
      const project = a.fn(s.project);
      if (project === s.project) return s;
      const merge = !!a.group && s.group === a.group && a.at - s.at < 800;
      return {
        ...s,
        project,
        past: merge ? s.past : [...s.past, s.project].slice(-80),
        future: [],
        group: a.group,
        at: a.at,
      };
    }
    case "undo": {
      const project = s.past.at(-1);
      return project
        ? {
            ...s,
            project,
            past: s.past.slice(0, -1),
            future: [s.project, ...s.future],
            group: "",
            origin: null,
          }
        : s;
    }
    case "redo": {
      const project = s.future[0];
      return project
        ? {
            ...s,
            project,
            past: [...s.past, s.project],
            future: s.future.slice(1),
            group: "",
            origin: null,
          }
        : s;
    }
  }
}
export function persistable(p: Project): PersistedProject {
  return {
    ...p,
    updatedAt: Date.now(),
    assets: p.assets
      .filter((a) => a.kind !== "demo")
      .map((a) => {
        const { url: _url, ...rest } = a;
        void _url;
        return rest as PersistedAsset;
      }),
  };
}

export function useProject(onError: (message: string) => void) {
  const [state, dispatch] = useReducer(historyReducer, undefined, () => ({
    project: newProject(),
    past: [],
    future: [],
    origin: null,
    group: "",
    at: 0,
  }));
  const [ready, setReady] = useState(false),
    [saveState, setSaveState] = useState("Loading project");
  const blobs = useRef(new Map<string, PersistedMedia>()),
    urls = useRef(new Map<string, string>());
  const queuedWaveforms = useRef(new Set<string>());
  const waveformQueue = useRef(Promise.resolve());
  const current = useRef(state.project);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const deletedProjects = useRef(new Set<string>());
  const persist = useCallback((project: Project) => {
    const saving = saveQueue.current.then(async () => {
      if (deletedProjects.current.has(project.id)) return;
      const available = project.assets.flatMap(asset => {
        const media = blobs.current.get(asset.id); return media ? [media] : [];
      });
      await saveProject(persistable(project), available);
    });
    saveQueue.current = saving.catch(() => {});
    return saving;
  }, []);
  useEffect(() => {
    current.current = state.project;
  }, [state.project]);
  const restore = useCallback((raw: unknown) => {
    const r = raw as { assets?: Asset[] };
    const assets = (r.assets ?? [])
      .map((a) => {
        const media = blobs.current.get(a.id);
        if (!media) return { ...a, url: undefined };
        let url = urls.current.get(a.id);
        if (!url) {
          url = URL.createObjectURL(media.blob);
          urls.current.set(a.id, url);
        }
        return { ...a, url };
      })
      .filter((a): a is Asset & { url: string | undefined } => !!a);
    return migrateProject(raw, assets);
  }, []);
  useEffect(() => {
    let active = true;
    void loadProject()
      .then(({ project, media }) => {
        if (!active) return;
        for (const m of media) blobs.current.set(m.id, m);
        if (project) dispatch({ type: "load", project: restore(project) });
        setReady(true);
        setSaveState("Saved on this device");
      })
      .catch((error) => {
        if (active) {
          setReady(true);
          setSaveState("Storage unavailable");
          onError(String(error.message));
        }
      });
    return () => {
      active = false;
    };
  }, [restore, onError]);
  useEffect(() => {
    if (!ready) return;
    for (const asset of state.project.assets) {
      const needsAudio = asset.kind === "audio" || state.project.clips.some((clip) => clip.assetId === asset.id && clip.kind === "audio");
      if (!needsAudio || (asset.waveformPeaks?.length ?? 0) >= 1024 || queuedWaveforms.current.has(asset.id)) continue;
      const blob = blobs.current.get(asset.id)?.blob;
      if (!blob) continue;
      queuedWaveforms.current.add(asset.id);
      waveformQueue.current = waveformQueue.current.then(async () => {
        const data = await analyzeAudioWaveform(blob);
        if (data) dispatch({ type: "waveform", id: asset.id, data });
      }).catch(() => {});
    }
  }, [ready, state.project.assets, state.project.clips]);
  useEffect(() => {
    if (!ready || state.origin) return;
    let active = true;
    const timer = setTimeout(() => {
      setSaveState("Saving…");
      void persist(state.project)
        .then(() => {
          if (active) setSaveState("Saved on this device");
        })
        .catch((error) => {
          if (active) {
            setSaveState("Save failed — make a backup");
            onError(error.message);
          }
        });
    }, 180);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [state.project, state.origin, ready, onError, persist]);
  useEffect(() => {
    return window.cutlineDesktop?.onBeforeClose(async () => {
      if (ready) await persist(current.current);
    });
  }, [ready, persist]);
  useEffect(() => {
    const save = () => {
      if (ready) void persist(current.current).catch(() => {});
    };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      save();
      if (saveState.startsWith("Save failed")) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("pagehide", save);
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      window.removeEventListener("pagehide", save);
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, [ready, saveState, persist]);
  const edit = useCallback(
    (fn: (p: Project) => Project, group = "") =>
      dispatch({ type: "edit", fn, group, at: Date.now() }),
    [],
  );
  const addMedia = useCallback(async (asset: Asset, blob: Blob) => {
    const { url: _url, ...rest } = asset;
    void _url;
    const m = { ...rest, blob } as PersistedMedia;
    await saveMediaAsset(m);
    blobs.current.set(asset.id, m);
    if (asset.url) urls.current.set(asset.id, asset.url);
  }, []);
  const load = useCallback(async (p: Project) => {
    await persist(current.current);
    await persist(p);
    current.current = p;
    dispatch({ type: "load", project: p });
  }, [persist]);
  const removeProject = useCallback(async (id: string) => {
    // Flush first so deletion includes newly imported media, then fence every
    // queued/autosave/close callback from resurrecting the deleted project.
    await persist(current.current);
    const active = current.current.id === id;
    const replacement = active ? newProject() : undefined;
    deletedProjects.current.add(id);
    const deleting = saveQueue.current.then(() => deleteSavedProject(id, replacement && persistable(replacement)));
    saveQueue.current = deleting.then(() => {}, () => {});
    try {
      const result = await deleting;
      if (replacement) {
        current.current = replacement;
        dispatch({ type: "load", project: replacement });
        for (const assetId of result.removedMediaIds) {
          const url = urls.current.get(assetId);
          if (url) URL.revokeObjectURL(url);
          urls.current.delete(assetId); blobs.current.delete(assetId);
        }
      }
      return { active };
    } catch (error) { deletedProjects.current.delete(id); throw error; }
  }, [persist]);
  const backup = useCallback(async () => {
    const p = current.current,
      files: Record<string, Uint8Array> = {
        "project.json": strToU8(JSON.stringify(persistable(p))),
      };
    for (const a of p.assets.filter((a) => a.kind !== "demo")) {
      const media = blobs.current.get(a.id);
      if (!media) throw new Error("Missing media: " + a.name);
      files["media/" + a.id] = new Uint8Array(await media.blob.arrayBuffer());
    }
    return new Blob([zipSync(files, { level: 0 }) as Uint8Array<ArrayBuffer>], {
      type: "application/zip",
    });
  }, []);
  const importBackup = useCallback(
    async (file: File) => {
      if (file.size > 1024 * 1024 * 1024)
        throw new Error(
          "Project backups larger than 1 GB cannot be opened in this version.",
        );
      let expandedSize = 0;
      const files = unzipSync(new Uint8Array(await file.arrayBuffer()), {
        filter: (entry) => {
          expandedSize += entry.originalSize;
          if (expandedSize > 1024 * 1024 * 1024)
            throw new Error(
              "The expanded backup exceeds the 1 GB safety limit.",
            );
          return (
            entry.name === "project.json" || entry.name.startsWith("media/")
          );
        },
      });
      if (!files["project.json"])
        throw new Error("This is not a Cutline project backup.");
      const raw = JSON.parse(strFromU8(files["project.json"]));
      if (
        (raw.version !== 2 && raw.version !== 3) ||
        !Array.isArray(raw.assets) ||
        !Array.isArray(raw.clips) ||
        !Array.isArray(raw.texts)
      )
        throw new Error("Unsupported or damaged project backup.");
      const assets: Asset[] = [];
      const ids = new Map<string, string>();
      if (
        raw.assets.length > 1000 ||
        raw.clips.length > 10000 ||
        raw.texts.length > 10000
      )
        throw new Error("This backup exceeds the supported project size.");
      for (const a of raw.assets as Asset[]) {
        if (
          !a ||
          typeof a.id !== "string" ||
          typeof a.name !== "string" ||
          !["image", "audio", "video"].includes(a.kind) ||
          !Number.isFinite(a.duration) ||
          a.duration <= 0
        )
          throw new Error("The backup contains invalid media metadata.");
        const bytes = files["media/" + a.id];
        if (!bytes) throw new Error("The backup is missing " + a.name);
        const blob = new Blob([bytes as Uint8Array<ArrayBuffer>]);
        const id = uid("asset");
        ids.set(a.id, id);
        const asset = { ...a, id, url: URL.createObjectURL(blob) };
        await addMedia(asset, blob);
        assets.push(asset);
      }
      raw.clips = raw.clips.map((c: Record<string, unknown>) => ({
        ...c,
        assetId: ids.get(String(c.assetId)) ?? c.assetId,
      }));
      const p = migrateProject(raw, assets);
      p.id = uid("project");
      await load(p);
    },
    [addMedia, load],
  );
  return {
    project: state.project,
    ready,
    saveState,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
    edit,
    dispatch,
    addMedia,
    load,
    removeProject,
    restore,
    backup,
    importBackup,
  };
}
