import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import { initSqlite } from '../../../src/sqlite';
import { LocalApi } from '../../../src/app';
import type { Host } from '../../../src/app';
import type { Db } from '../../../src/db';
import { addSnapshot, askToKeepStorage, deleteValue, getValue, hasSnapshotToday, setValue } from './storage';
import { folderStatus, loadFolder, writeToFolder } from './folder';

/**
 * Starts WalletWhisper inside this page: loads SQLite, opens the data saved in this browser, and
 * saves again shortly after every change. Only one tab at a time may have the data open, so two
 * tabs can't overwrite each other's changes.
 */

export interface SaveState {
  /** When the data was last saved in this browser. */
  savedAt: Date | null;
  /** When it was last written to the linked folder (Chrome/Edge). */
  folderSavedAt: Date | null;
  saving: boolean;
  error: string | null;
}

let api: LocalApi | null = null;
let aiKey: string | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let dirty = false;
let state: SaveState = { savedAt: null, folderSavedAt: null, saving: false, error: null };
const listeners = new Set<(s: SaveState) => void>();

const setState = (patch: Partial<SaveState>) => {
  state = { ...state, ...patch };
  listeners.forEach(l => l(state));
};

export const saveState = () => state;
export function onSaveState(fn: (s: SaveState) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

async function flush(): Promise<void> {
  if (timer) { clearTimeout(timer); timer = null; }
  const db = api?.database;
  if (!dirty || !db) return;
  dirty = false;
  setState({ saving: true });
  try {
    const bytes = db.export();
    await setValue('data', bytes);
    setState({ savedAt: new Date(), error: null });
    try {
      if (await writeToFolder(bytes)) setState({ folderSavedAt: new Date() });
    } catch (err: any) {
      setState({ error: `Saved in this browser, but couldn't write to your folder: ${err.message}` });
    }
  } catch (err: any) {
    dirty = true;
    setState({ error: `Couldn't save your changes: ${err?.message ?? err}. Download a backup file in Settings to be safe.` });
  } finally {
    setState({ saving: false });
  }
}

/** Save now (e.g. before linking a folder) instead of waiting. */
export async function saveNow(): Promise<void> {
  dirty = true;
  await flush();
}

const host: Host = {
  save(_db: Db) {
    dirty = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, 300);
  },
  snapshot: (label, data) => addSnapshot(label, data),
  aiKey: () => aiKey,
  setAiKey(key) {
    aiKey = key;
    (key ? setValue('aiKey', key) : deleteValue('aiKey')).catch(console.error);
  },
};

export type BootResult = { status: 'ready'; api: LocalApi } | { status: 'open-elsewhere' };

/** Hold the "data is open" lock for as long as this tab lives. Resolves false if another tab has it. */
function takeTabLock(): Promise<boolean> {
  if (!navigator.locks) return Promise.resolve(true);
  return new Promise(resolve => {
    navigator.locks.request('walletwhisper-data', { ifAvailable: true }, lock => {
      resolve(lock !== null);
      return lock ? new Promise<never>(() => {}) : undefined; // never released while the tab is open
    });
  });
}

let booting: Promise<BootResult> | null = null;

export function boot(): Promise<BootResult> {
  booting ??= (async (): Promise<BootResult> => {
    if (!(await takeTabLock())) return { status: 'open-elsewhere' };
    await initSqlite(wasmUrl);
    const [data, key] = await Promise.all([getValue<Uint8Array>('data'), getValue<string>('aiKey'), loadFolder()]);
    aiKey = key ?? null;
    if (data && !(await hasSnapshotToday())) await addSnapshot('daily', data);
    api = new LocalApi(host, data ?? null, (from, old) => { addSnapshot(`pre-upgrade-v${from}`, old).catch(console.error); });
    if (data) askToKeepStorage();

    // Save before the page goes away
    const leaving = () => { if (dirty) flush(); };
    window.addEventListener('pagehide', leaving);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') leaving(); });
    window.addEventListener('beforeunload', e => { if (dirty || state.saving) e.preventDefault(); });
    return { status: 'ready', api };
  })();
  return booting;
}

export const linkedFolder = folderStatus;

/** Reload the page once the latest changes are saved (after restoring or combining a backup). */
export async function reloadWhenSaved(): Promise<void> {
  await saveNow();
  window.location.reload();
}

/** Stop saving (just before erasing everything), so nothing is written back afterwards. */
export function stopSaving(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  dirty = false;
  api = null;
}
