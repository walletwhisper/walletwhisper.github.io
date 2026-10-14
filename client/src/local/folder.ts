import { deleteValue, getValue, setValue } from './storage';

/**
 * Optional: keep an always-up-to-date copy of the data in a folder the user picks (Chrome and Edge
 * only; they let a website write to one folder you choose). It protects against the browser's
 * storage being cleared, and makes the data easy to find. Browsers ask again for permission after
 * a restart, so the user may need to click "Reconnect".
 */

export const FOLDER_FILE = 'WalletWhisper data.db';

type Permission = 'granted' | 'prompt' | 'denied';
interface DirHandle extends FileSystemDirectoryHandle {
  queryPermission(opts: { mode: 'readwrite' }): Promise<Permission>;
  requestPermission(opts: { mode: 'readwrite' }): Promise<Permission>;
}
declare global {
  interface Window { showDirectoryPicker?: (opts?: { id?: string; mode?: 'readwrite'; startIn?: string }) => Promise<FileSystemDirectoryHandle> }
}

export const folderSupported = () => typeof window.showDirectoryPicker === 'function';

export interface FolderStatus { name: string; permission: Permission }

let handle: DirHandle | null = null;
let permission: Permission = 'prompt';

/** Load the linked folder (if any) when the app starts. */
export async function loadFolder(): Promise<FolderStatus | null> {
  handle = (await getValue<DirHandle>('folder')) ?? null;
  if (!handle) return null;
  try { permission = await handle.queryPermission({ mode: 'readwrite' }); } catch { permission = 'prompt'; }
  return { name: handle.name, permission };
}

export const folderStatus = (): FolderStatus | null => (handle ? { name: handle.name, permission } : null);

/** Let the user pick a folder. Returns null if they cancelled. */
export async function chooseFolder(): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await window.showDirectoryPicker!({ id: 'walletwhisper', mode: 'readwrite', startIn: 'documents' });
  } catch (err: any) {
    if (err?.name === 'AbortError') return null;
    throw err;
  }
}

export async function linkFolder(dir: FileSystemDirectoryHandle): Promise<void> {
  handle = dir as DirHandle;
  permission = await handle.queryPermission({ mode: 'readwrite' });
  if (permission !== 'granted') permission = await handle.requestPermission({ mode: 'readwrite' });
  await setValue('folder', handle);
}

/** After a browser restart: ask again for permission (must be called from a click). */
export async function reconnectFolder(): Promise<Permission> {
  if (!handle) return 'denied';
  permission = await handle.requestPermission({ mode: 'readwrite' });
  return permission;
}

export async function unlinkFolder(): Promise<void> {
  handle = null;
  permission = 'prompt';
  await deleteValue('folder');
}

/** The WalletWhisper data file in a folder, if there is one. */
export async function readFolderFile(dir: FileSystemDirectoryHandle): Promise<File | null> {
  try {
    return await (await dir.getFileHandle(FOLDER_FILE)).getFile();
  } catch {
    return null;
  }
}

/** Write the latest data to the linked folder. Quietly does nothing until permission is granted. */
export async function writeToFolder(bytes: Uint8Array): Promise<boolean> {
  if (!handle || permission !== 'granted') return false;
  const file = await handle.getFileHandle(FOLDER_FILE, { create: true });
  const out = await file.createWritable();
  await out.write(bytes as Uint8Array<ArrayBuffer>);
  await out.close();
  return true;
}
