import { useEffect, useState } from 'react';
import { AlertTriangle, FolderSync, ShieldCheck, X } from 'lucide-react';
import { onSaveState, saveNow, saveState } from './local/engine';
import type { SaveState } from './local/engine';
import { folderStatus, reconnectFolder } from './local/folder';
import { getValue, setValue } from './local/storage';
import { useRoute } from './lib';
import { useFetch } from './store';
import type { ImportRecord } from './api';

const REMIND_AFTER_DAYS = 30;
/** Don't nag on day one: remind once the data has been here a few days. */
const FIRST_REMINDER_AFTER_DAYS = 3;
const daysSince = (iso: string | undefined) => (iso ? (Date.now() - Date.parse(iso)) / 86_400_000 : Infinity);

export function useSaveState(): SaveState {
  const [s, setS] = useState(saveState());
  useEffect(() => onSaveState(setS), []);
  return s;
}

/** Record that the user has a backup file, so the reminder stays quiet for a while. */
export const markBackedUp = () => setValue('lastBackupAt', new Date().toISOString()).catch(console.error);

/**
 * Problems worth interrupting for: a save that failed, a linked folder that needs permission again
 * after a browser restart, or data that has never been backed up outside this browser.
 */
export function SaveBanner() {
  const save = useSaveState();
  const { navigate } = useRoute();
  const [folder, setFolder] = useState(folderStatus());
  const [remind, setRemind] = useState(false);
  const imports = useFetch<{ imports: ImportRecord[] }>('/api/imports').data?.imports;
  const firstImport = imports?.length ? imports[imports.length - 1].importedAt : undefined;

  useEffect(() => {
    if (!firstImport || daysSince(firstImport) < FIRST_REMINDER_AFTER_DAYS || folderStatus()) return;
    Promise.all([getValue<string>('lastBackupAt'), getValue<string>('backupReminderSnoozedAt')])
      .then(([backedUp, snoozed]) => setRemind(daysSince(backedUp) > REMIND_AFTER_DAYS && daysSince(snoozed) > REMIND_AFTER_DAYS))
      .catch(() => {});
  }, [firstImport]);

  if (save.error) {
    return (
      <Banner tone="bad" icon={<AlertTriangle className="w-4 h-4" />}>
        {save.error} <button className="underline cursor-pointer" onClick={() => saveNow()}>Try again</button>
      </Banner>
    );
  }
  if (folder && folder.permission !== 'granted') {
    return (
      <Banner tone="warn" icon={<FolderSync className="w-4 h-4" />}>
        Your data is saved in this browser. To keep the copy in your folder <b>{folder.name}</b> up to date, the browser needs your OK again.{' '}
        <button className="font-semibold underline cursor-pointer"
          onClick={async () => { await reconnectFolder(); setFolder(folderStatus()); await saveNow(); }}>Reconnect folder</button>
      </Banner>
    );
  }
  if (remind) {
    return (
      <Banner tone="accent" icon={<ShieldCheck className="w-4 h-4" />}
        onClose={() => { setRemind(false); setValue('backupReminderSnoozedAt', new Date().toISOString()).catch(() => {}); }}>
        Your data lives only in this browser. If its storage is ever cleared, it's gone, so download a backup file now and then.{' '}
        <button className="font-semibold underline cursor-pointer" onClick={() => navigate('settings')}>Back up in Settings</button>
      </Banner>
    );
  }
  return null;
}

function Banner({ tone, icon, children, onClose }: { tone: 'bad' | 'warn' | 'accent'; icon: React.ReactNode; children: React.ReactNode; onClose?: () => void }) {
  const border = { bad: 'border-bad', warn: 'border-orange', accent: 'border-accent' }[tone];
  const color = { bad: 'text-bad', warn: 'text-orange', accent: 'text-accent' }[tone];
  return (
    <div className="max-w-7xl w-full mx-auto px-4 sm:px-6 mt-4">
      <div className={`p-3 bg-surface shadow-card rounded-[10px] text-sm text-ink flex items-start gap-3 border-l-4 ${border}`}>
        <span className={`mt-0.5 ${color}`}>{icon}</span>
        <span className="flex-1">{children}</span>
        {onClose && <button onClick={onClose} className="text-muted hover:text-ink cursor-pointer" aria-label="Dismiss"><X className="w-4 h-4" /></button>}
      </div>
    </div>
  );
}
