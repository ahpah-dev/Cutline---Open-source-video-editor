const DATABASE_NAME = "cutline-local-projects";
const DATABASE_VERSION = 2;
const PROJECT_STORE = "project";
const MEDIA_STORE = "media";
const CURRENT_PROJECT_KEY = "current";
const ARCHIVE_STORE = "projects";

export type PersistedAsset = {
  id: string;
  name: string;
  kind: "video" | "image" | "audio";
  duration: number;
  sizeLabel: string;
  theme: string;
  thumbnail?: string;
  waveform?: number[];
  waveformPeaks?: number[];
  width?: number;
  height?: number;
};

export type PersistedMedia = PersistedAsset & {
  blob: Blob;
};

type LegacyProject = {
  version: 1;
  updatedAt: number;
  projectName: string;
  ratio: string;
  assets: PersistedAsset[];
  clips: unknown[];
  texts: unknown[];
  audioClips: unknown[];
};
export type PersistedProject =
  | LegacyProject
  | (Omit<import("./editor/model").Project, "assets"> & {
      assets: PersistedAsset[];
      updatedAt: number;
    });

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(PROJECT_STORE)) {
        database.createObjectStore(PROJECT_STORE);
      }
      if (!database.objectStoreNames.contains(MEDIA_STORE)) {
        database.createObjectStore(MEDIA_STORE, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(ARCHIVE_STORE))
        database.createObjectStore(ARCHIVE_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(
        request.error ?? new Error("Could not open local project storage."),
      );
  });
}

function waitForTransaction(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(
        transaction.error ?? new Error("Local storage transaction failed."),
      );
    transaction.onabort = () =>
      reject(
        transaction.error ??
          new Error("Local storage transaction was cancelled."),
      );
  });
}

export async function saveMediaAsset(asset: PersistedMedia) {
  const database = await openDatabase();
  const transaction = database.transaction(MEDIA_STORE, "readwrite");
  transaction.objectStore(MEDIA_STORE).put(asset);
  await waitForTransaction(transaction);
  database.close();
}

export async function loadMediaAsset(assetId: string): Promise<PersistedMedia | undefined> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(MEDIA_STORE, "readonly");
    const request = transaction.objectStore(MEDIA_STORE).get(assetId);
    await waitForTransaction(transaction);
    return request.result as PersistedMedia | undefined;
  } finally {
    database.close();
  }
}

export async function deleteMediaAsset(assetId: string) {
  const database = await openDatabase();
  const transaction = database.transaction(MEDIA_STORE, "readwrite");
  transaction.objectStore(MEDIA_STORE).delete(assetId);
  await waitForTransaction(transaction);
  database.close();
}

function referencedMedia(projects: PersistedProject[]) {
  return new Set(projects.flatMap(project => project.assets.map(asset => asset.id)));
}

export async function saveProject(project: PersistedProject, availableMedia: PersistedMedia[] = []) {
  const database = await openDatabase();
  let failure: Error | undefined;
  try {
    const transaction = database.transaction([PROJECT_STORE, ARCHIVE_STORE, MEDIA_STORE], "readwrite");
    const done = waitForTransaction(transaction), archives = transaction.objectStore(ARCHIVE_STORE), media = transaction.objectStore(MEDIA_STORE);
    const removedMediaIds: string[] = [];
    if ("id" in project) {
      const deleted = transaction.objectStore(PROJECT_STORE).get(`deleted:${project.id}`);
      deleted.onsuccess = () => {
        if (deleted.result) { failure = new Error("This project was deleted. Open another project or import a backup."); transaction.abort(); }
      };
    }
    // Undo may restore an asset whose unused stored copy was reclaimed. Write
    // only missing blobs; normal autosaves do not repeatedly clone large files.
    const used = new Set(project.assets.map(asset => asset.id));
    for (const asset of availableMedia) if (used.has(asset.id)) {
      const key = media.getKey(asset.id);
      key.onsuccess = () => { if (key.result === undefined) media.put(asset); };
    }
    const request = archives.getAll();
    request.onsuccess = () => {
      const saved = request.result as PersistedProject[];
      const previous = "id" in project ? saved.find(p => "id" in p && p.id === project.id) : undefined;
      const remaining = saved.filter(p => !("id" in project && "id" in p && p.id === project.id));
      const retained = referencedMedia([...remaining, project]);
      for (const asset of previous?.assets ?? []) if (!retained.has(asset.id)) {
        media.delete(asset.id); removedMediaIds.push(asset.id);
      }
      transaction.objectStore(PROJECT_STORE).put(project, CURRENT_PROJECT_KEY);
      if ("id" in project) archives.put(project, project.id);
    };
    await done;
    return { removedMediaIds };
  } catch (error) { throw failure ?? error; }
  finally { database.close(); }
}

/** Delete exactly one saved project and only blobs no remaining project uses. */
export async function deleteSavedProject(id: string, replacement?: PersistedProject) {
  const database = await openDatabase();
  let failure: Error | undefined;
  try {
    const transaction = database.transaction([PROJECT_STORE, ARCHIVE_STORE, MEDIA_STORE], "readwrite");
    const done = waitForTransaction(transaction), archives = transaction.objectStore(ARCHIVE_STORE), currentStore = transaction.objectStore(PROJECT_STORE);
    const projectsRequest = archives.getAll(), currentRequest = currentStore.get(CURRENT_PROJECT_KEY);
    let pending = 2; const removedMediaIds: string[] = [];
    const apply = () => {
      if (--pending) return;
      const projects = projectsRequest.result as PersistedProject[], current = currentRequest.result as PersistedProject | undefined;
      const target = projects.find(p => "id" in p && p.id === id);
      if (!target) { failure = new Error("This project no longer exists."); transaction.abort(); return; }
      const active = current && "id" in current && current.id === id;
      if (active && (!replacement || !("id" in replacement) || replacement.id === id)) {
        failure = new Error("Choose a new workspace before deleting the open project."); transaction.abort(); return;
      }
      const remaining = projects.filter(p => !("id" in p && p.id === id));
      if (active && replacement && "id" in replacement && remaining.some(p => "id" in p && p.id === replacement.id)) {
        failure = new Error("Deleting a project cannot replace another saved project."); transaction.abort(); return;
      }
      const nextCurrent = active ? replacement : current;
      const retained = referencedMedia([...remaining, ...(nextCurrent ? [nextCurrent] : [])]);
      archives.delete(id);
      currentStore.put({ deletedAt: Date.now() }, `deleted:${id}`);
      if (active && replacement && "id" in replacement) {
        currentStore.put(replacement, CURRENT_PROJECT_KEY); archives.put(replacement, replacement.id);
      }
      for (const asset of target.assets) if (!retained.has(asset.id)) {
        transaction.objectStore(MEDIA_STORE).delete(asset.id); removedMediaIds.push(asset.id);
      }
    };
    projectsRequest.onsuccess = apply; currentRequest.onsuccess = apply;
    await done;
    return { removedMediaIds };
  } catch (error) { throw failure ?? error; }
  finally { database.close(); }
}

export async function listProjects(): Promise<PersistedProject[]> {
  const database = await openDatabase();
  const transaction = database.transaction(ARCHIVE_STORE, "readonly");
  const request = transaction.objectStore(ARCHIVE_STORE).getAll();
  await waitForTransaction(transaction);
  database.close();
  return (request.result as PersistedProject[]).sort(
    (a, b) => b.updatedAt - a.updatedAt,
  );
}

export async function loadProject() {
  const database = await openDatabase();
  const transaction = database.transaction(
    [PROJECT_STORE, MEDIA_STORE],
    "readonly",
  );
  const projectRequest = transaction
    .objectStore(PROJECT_STORE)
    .get(CURRENT_PROJECT_KEY);
  const mediaRequest = transaction.objectStore(MEDIA_STORE).getAll();
  const result = await new Promise<{
    project: PersistedProject | null;
    media: PersistedMedia[];
  }>((resolve, reject) => {
    transaction.oncomplete = () => {
      resolve({
        project:
          (projectRequest.result as PersistedProject | undefined) ?? null,
        media: (mediaRequest.result as PersistedMedia[] | undefined) ?? [],
      });
    };
    transaction.onerror = () =>
      reject(
        transaction.error ?? new Error("Could not restore the local project."),
      );
  });
  database.close();
  return result;
}

export async function clearProject() {
  const database = await openDatabase();
  const transaction = database.transaction(
    [PROJECT_STORE, MEDIA_STORE],
    "readwrite",
  );
  transaction.objectStore(PROJECT_STORE).clear();
  transaction.objectStore(MEDIA_STORE).clear();
  await waitForTransaction(transaction);
  database.close();
}
