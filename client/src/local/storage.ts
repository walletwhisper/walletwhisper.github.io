/**
 * Where WalletWhisper keeps your data: the browser's own storage on this computer (IndexedDB).
 * Nothing here is sent anywhere. Each website gets its own private storage, so other sites
 * can't read it.
 *
 *   kv         'data' → the database (SQLite bytes), 'aiKey' → your AI key, 'folder' → linked folder
 *   snapshots  automatic copies kept before risky changes, and one a day
 */

const DB_NAME = 'walletwhisper';
const KEEP_EVENT_SNAPSHOTS = 10;
const KEEP_DAILY_SNAPSHOTS = 7;

export interface SnapshotMeta { id: number; label: string; createdAt: string; size: number }
interface SnapshotRow extends SnapshotMeta { bytes: Uint8Array }

let opening: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('kv');
      req.result.createObjectStore('snapshots', { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Close other WalletWhisper tabs and reload.'));
  });
  return opening;
}

async function run<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest | void): Promise<T> {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req ? (req.result as T) : (undefined as T));
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Saving was interrupted'));
  });
}

export const getValue = <T>(key: string) => run<T | undefined>('kv', 'readonly', s => s.get(key));
export const setValue = (key: string, value: unknown) => run<void>('kv', 'readwrite', s => { s.put(value, key); });
export const deleteValue = (key: string) => run<void>('kv', 'readwrite', s => { s.delete(key); });

export async function listSnapshots(): Promise<SnapshotMeta[]> {
  const rows = await run<SnapshotRow[]>('snapshots', 'readonly', s => s.getAll());
  return rows.map(({ id, label, createdAt, size }) => ({ id, label, createdAt, size })).reverse();
}

export async function getSnapshot(id: number): Promise<SnapshotRow | undefined> {
  return run<SnapshotRow | undefined>('snapshots', 'readonly', s => s.get(id));
}

/** Keep a copy of the data, then drop the oldest copies beyond the limits. */
export async function addSnapshot(label: string, bytes: Uint8Array): Promise<void> {
  await run<void>('snapshots', 'readwrite', s => { s.add({ label, createdAt: new Date().toISOString(), size: bytes.length, bytes }); });
  const all = await listSnapshots(); // newest first
  const daily = all.filter(x => x.label === 'daily');
  const events = all.filter(x => x.label !== 'daily');
  const extra = [...daily.slice(KEEP_DAILY_SNAPSHOTS), ...events.slice(KEEP_EVENT_SNAPSHOTS)];
  if (extra.length) await run<void>('snapshots', 'readwrite', s => { for (const x of extra) s.delete(x.id); });
}

export async function hasSnapshotToday(): Promise<boolean> {
  const today = new Date().toISOString().slice(0, 10);
  return (await listSnapshots()).some(x => x.label === 'daily' && x.createdAt.startsWith(today));
}

/** Delete everything WalletWhisper saved in this browser. */
export async function eraseEverything(): Promise<void> {
  (await open()).close();
  opening = null;
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

/** Ask the browser not to clear this site's storage when the disk gets full. */
export async function askToKeepStorage(): Promise<boolean> {
  try {
    if (await navigator.storage?.persisted?.()) return true;
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

export async function storageUsage(): Promise<number | null> {
  try { return (await navigator.storage?.estimate?.())?.usage ?? null; } catch { return null; }
}
