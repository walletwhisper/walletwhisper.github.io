import { useEffect, useState } from 'react';
import { Download, FolderOpen, HardDrive } from 'lucide-react';
import { saveFile } from '../api';
import { saveNow, stopSaving } from '../local/engine';
import { chooseFolder, folderStatus, folderSupported, FOLDER_FILE, linkFolder, reconnectFolder, unlinkFolder } from '../local/folder';
import { eraseEverything, getSnapshot, listSnapshots, storageUsage } from '../local/storage';
import type { SnapshotMeta } from '../local/storage';
import { useSaveState } from '../SaveStatus';
import { useStore } from '../store';
import { Button, Card, inputClass } from '../ui';

const ERASE_CONFIRMATION = 'ERASE';
const when = (d: Date | string) => new Date(d).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
const size = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

const SNAPSHOT_LABELS: Record<string, string> = {
  daily: 'Daily copy',
  'before-reset': 'Before reset',
  'before-restore': 'Before opening a backup',
  'before-merge': 'Before combining a backup',
};
const snapshotLabel = (label: string) =>
  SNAPSHOT_LABELS[label] ?? (label.startsWith('before-undo-import') ? 'Before undoing an import' : label.startsWith('pre-upgrade') ? 'Before an app update' : label);

/** Settings card: where the data is kept, the optional folder copy, automatic copies, and erasing. */
export function YourData() {
  const { toast } = useStore();
  const save = useSaveState();
  const [folder, setFolder] = useState(folderStatus());
  const [snapshots, setSnapshots] = useState<SnapshotMeta[]>([]);
  const [usage, setUsage] = useState<number | null>(null);
  const [erasing, setErasing] = useState(false);
  const [confirm, setConfirm] = useState('');

  useEffect(() => {
    listSnapshots().then(setSnapshots).catch(console.error);
    storageUsage().then(setUsage);
  }, [save.savedAt]);

  const pickFolder = async () => {
    try {
      const dir = await chooseFolder();
      if (!dir) return;
      await linkFolder(dir);
      setFolder(folderStatus());
      await saveNow();
      toast(`WalletWhisper will keep "${FOLDER_FILE}" in ${dir.name} up to date.`);
    } catch (e: any) { toast(e.message); }
  };

  const downloadSnapshot = async (s: SnapshotMeta) => {
    const row = await getSnapshot(s.id);
    if (row) saveFile(row.bytes, `walletwhisper-${s.label}-${s.createdAt.slice(0, 10)}.db`);
  };

  const erase = async () => {
    stopSaving();
    await eraseEverything();
    await unlinkFolder().catch(() => {});
    window.location.reload();
  };

  return (
    <Card title={<span className="flex items-center gap-2"><HardDrive className="w-4 h-4 text-accent" /> Your data</span>}
      subtitle="Everything WalletWhisper knows is saved in this browser's private storage, on this computer. It's never uploaded.">
      <div className="space-y-5 text-sm">
        <p className="text-ink-2">
          {save.savedAt ? <>Last saved {when(save.savedAt)}.</> : <>Saved automatically after every change.</>}
          {usage !== null && <> Using about {size(usage)}, including automatic copies.</>}
          {' '}Other websites can't read it. Clearing this browser's site data for WalletWhisper would delete it, so keep a backup file.
        </p>

        {folderSupported() && (
          <div className="rounded-[10px] bg-page p-3 space-y-2">
            <p className="font-semibold text-ink flex items-center gap-2"><FolderOpen className="w-4 h-4 text-accent" /> Keep a copy in a folder</p>
            {folder ? (
              <>
                <p className="text-xs text-ink-2">
                  {folder.permission === 'granted'
                    ? <>A copy is saved to <b>{folder.name}/{FOLDER_FILE}</b> after every change{save.folderSavedAt && <>, last at {when(save.folderSavedAt)}</>}.</>
                    : <>The browser needs your OK again to update <b>{folder.name}/{FOLDER_FILE}</b>.</>}
                </p>
                <div className="flex flex-wrap gap-2">
                  {folder.permission !== 'granted' && (
                    <Button variant="primary" onClick={async () => { await reconnectFolder(); setFolder(folderStatus()); await saveNow(); }}>Reconnect</Button>
                  )}
                  <Button onClick={pickFolder}>Change folder</Button>
                  <Button variant="ghost" onClick={async () => { await unlinkFolder(); setFolder(null); }}>Stop keeping a copy</Button>
                </div>
              </>
            ) : (
              <>
                <p className="text-xs text-muted">
                  Your browser can also save a copy to a folder you choose, after every change. That protects your data if the browser's
                  storage is cleared. If the folder is synced (OneDrive, Dropbox, iCloud), the copy goes there too.
                </p>
                <Button onClick={pickFolder}>Choose folder</Button>
              </>
            )}
          </div>
        )}

        <div>
          <p className="font-semibold text-ink">Automatic copies</p>
          <p className="text-xs text-muted mt-0.5">Kept in this browser: one a day for a week, and one before each undo, reset or restore.</p>
          {snapshots.length === 0 ? (
            <p className="text-xs text-muted mt-2">None yet.</p>
          ) : (
            <ul className="mt-2 divide-y divide-line border border-line rounded-[10px] max-h-56 overflow-y-auto">
              {snapshots.map(s => (
                <li key={s.id} className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
                  <span><b className="text-ink">{snapshotLabel(s.label)}</b> <span className="text-muted">· {when(s.createdAt)} · {size(s.size)}</span></span>
                  <Button variant="ghost" onClick={() => downloadSnapshot(s)}><Download className="w-3.5 h-3.5" /> Download</Button>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-muted mt-2">A downloaded copy can be opened with <b>Open a backup file</b> below.</p>
        </div>

        <div className="pt-4 border-t border-line">
          {!erasing ? (
            <Button variant="danger" onClick={() => setErasing(true)}>Erase everything from this browser…</Button>
          ) : (
            <div className="space-y-2">
              <p className="text-ink-2">
                This deletes all your WalletWhisper data, automatic copies and AI key from this browser. Backup files you downloaded and
                any folder copy are not touched. Type <b>{ERASE_CONFIRMATION}</b> to confirm.
              </p>
              <div className="flex gap-2">
                <input value={confirm} onChange={e => setConfirm(e.target.value)} className={`${inputClass} w-40 !text-sm !py-2`} autoFocus />
                <Button variant="danger" disabled={confirm !== ERASE_CONFIRMATION} onClick={erase}>Erase</Button>
                <Button variant="ghost" onClick={() => { setErasing(false); setConfirm(''); }}>Cancel</Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
