// "A folder I choose" mode: File System Access API (Chrome/Edge only).
// The directory handle is persisted in IndexedDB so the user picks it once.
// Window contexts only — not available in a service worker.

const DB_NAME = 'media-grabber-db';
const STORE = 'handles';
const KEY = 'downloadDir';

type PermissionHandle = FileSystemDirectoryHandle & {
  queryPermission(opts: { mode: 'readwrite' }): Promise<PermissionState>;
  requestPermission(opts: { mode: 'readwrite' }): Promise<PermissionState>;
};

declare global {
  interface Window {
    showDirectoryPicker?: (opts?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
  }
}

export function isDirectoryModeSupported(): boolean {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await openDb();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = run(t.objectStore(STORE));
      t.oncomplete = () => resolve(req ? req.result : undefined);
      t.onerror = () => reject(t.error);
    });
  } finally {
    db.close();
  }
}

export async function saveDirHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  await tx('readwrite', (s) => {
    s.put(handle, KEY);
  });
}

export async function loadDirHandle(): Promise<FileSystemDirectoryHandle | null> {
  return ((await tx<FileSystemDirectoryHandle>('readonly', (s) => s.get(KEY))) ?? null) as FileSystemDirectoryHandle | null;
}

export async function clearDirHandle(): Promise<void> {
  await tx('readwrite', (s) => {
    s.delete(KEY);
  });
}

export async function pickDirectory(): Promise<FileSystemDirectoryHandle> {
  const handle = await window.showDirectoryPicker!({ mode: 'readwrite' });
  await saveDirHandle(handle);
  return handle;
}

/** Silent when permission is still granted; prompts only if the browser revoked it. */
export async function ensurePermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
  const h = handle as PermissionHandle;
  if ((await h.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
  return (await h.requestPermission({ mode: 'readwrite' })) === 'granted';
}

async function exists(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}

export interface UniqueWritable {
  writable: FileSystemWritableFileStream;
  /** Removes the (partial/empty) file — call after abort() on failure. */
  discard(): Promise<void>;
}

/**
 * Opens `path` (sub/dirs/name.ext) for writing. If a file with that name is
 * already there, picks "name (2).ext" etc. — the old code overwrote files
 * from earlier downloads (or two different images both called "image.jpg").
 */
export async function createUniqueWritable(root: FileSystemDirectoryHandle, path: string): Promise<UniqueWritable> {
  const parts = path.split('/').filter(Boolean);
  const fileName = parts.pop()!;
  let dir = root;
  for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });

  const dot = fileName.lastIndexOf('.');
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const ext = dot > 0 ? fileName.slice(dot) : '';
  let candidate = fileName;
  for (let n = 2; await exists(dir, candidate); n++) candidate = `${stem} (${n})${ext}`;

  const fileHandle = await dir.getFileHandle(candidate, { create: true });
  const writable = await fileHandle.createWritable();
  return {
    writable,
    discard: () => dir.removeEntry(candidate).catch(() => {}),
  };
}
