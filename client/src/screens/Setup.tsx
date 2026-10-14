import { useRef, useState } from 'react';
import { FolderLock, Laptop } from 'lucide-react';
import { api, sendBackup } from '../api';
import type { BackupInfo } from '../api';
import { inputClass } from '../ui';

/**
 * First run: the user chooses the folder on this computer where WalletWhisper keeps its data,
 * and can start from a backup file made on another computer instead of importing everything again.
 */
export function Setup({ suggestedFolder, onDone }: { suggestedFolder: string; onDone: () => void }) {
  const [folder, setFolder] = useState(suggestedFolder);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const fileInput = useRef<HTMLInputElement>(null);
  const [restoring, setRestoring] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState('');
  const [needsPassword, setNeedsPassword] = useState(false);
  const [info, setInfo] = useState<BackupInfo | null>(null);

  const inspect = async (f: File, pw: string) => {
    setError(null);
    try {
      const r = await sendBackup<{ needsPassword: boolean; info?: BackupInfo }>('inspect', f, pw);
      setNeedsPassword(r.needsPassword);
      setInfo(r.info ?? null);
    } catch (e: any) { setError(e.message); setInfo(null); }
  };

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/setup', { folder });
      if (restoring && file && info) {
        await sendBackup('restore', file, password);
        window.location.reload();
        return;
      }
      onDone();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const waitingForBackup = restoring && !info;

  return (
    <div className="min-h-screen bg-page font-sans flex items-center justify-center p-4">
      <div className="bg-surface rounded-card shadow-card w-full max-w-lg p-8">
        <h1 className="text-[28px] font-extrabold tracking-[-0.5px] text-ink">
          Welcome to Wallet<span className="text-accent">Whisper</span>
        </h1>
        <p className="text-[15px] text-ink-2 mt-2 leading-relaxed">
          Your bank statements and spending are saved on this computer, in a folder you choose. Nothing is uploaded.
        </p>

        <div className="mt-6 flex gap-3 items-start">
          <div className="w-10 h-10 min-w-10 rounded-full bg-accent/10 text-accent flex items-center justify-center">
            <FolderLock className="w-5 h-5" />
          </div>
          <label className="flex-1 block">
            <span className="text-sm font-semibold text-ink">Where should WalletWhisper keep your data?</span>
            <input value={folder} onChange={e => setFolder(e.target.value)} spellCheck={false}
              className={`${inputClass} w-full mt-2 !text-sm !py-2`} />
            <span className="block text-xs text-muted mt-1.5">
              The suggested folder is fine for most people. Backups are kept inside it, and you can move it later in Settings.
            </span>
          </label>
        </div>

        <div className="mt-5 flex gap-3 items-start">
          <div className="w-10 h-10 min-w-10 rounded-full bg-accent/10 text-accent flex items-center justify-center">
            <Laptop className="w-5 h-5" />
          </div>
          <div className="flex-1 text-sm">
            <label className="flex items-center gap-2 font-semibold text-ink cursor-pointer">
              <input type="checkbox" checked={restoring} onChange={e => { setRestoring(e.target.checked); setError(null); }} />
              Moving from another computer? Start from a backup file
            </label>
            {restoring && (
              <div className="mt-2 space-y-2 text-xs">
                <input ref={fileInput} type="file" accept=".wwbackup,.db" className="hidden"
                  onChange={e => {
                    const f = e.target.files?.[0];
                    e.target.value = '';
                    if (f) { setFile(f); setInfo(null); setPassword(''); setNeedsPassword(false); inspect(f, ''); }
                  }} />
                <p className="text-muted">
                  On the other computer, use <b>Settings → Move to another computer → Download backup file</b>, then choose that file here.
                </p>
                <button onClick={() => fileInput.current?.click()} className="text-accent hover:underline cursor-pointer">
                  {file ? `${file.name} (choose another)` : 'Choose backup file…'}
                </button>
                {needsPassword && !info && (
                  <div className="flex gap-2">
                    <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Backup password"
                      onKeyDown={e => { if (e.key === 'Enter' && file && password) inspect(file, password); }}
                      className={`${inputClass} flex-1`} />
                    <button onClick={() => file && inspect(file, password)} disabled={!password}
                      className="text-accent font-medium cursor-pointer disabled:opacity-40">Unlock</button>
                  </div>
                )}
                {info && (
                  <p className="text-ink-2">
                    Ready: {info.transactions.toLocaleString()} transactions{info.from && <> ({info.from} to {info.to})</>}, {info.accounts} accounts, {info.people} people.
                  </p>
                )}
              </div>
            )}
          </div>
        </div>

        {error && <p className="mt-4 text-sm text-bad">{error}</p>}

        <button onClick={start} disabled={busy || !folder.trim() || waitingForBackup}
          className="mt-6 w-full bg-accent hover:bg-accent-hover text-white rounded-full py-2.5 font-semibold text-sm cursor-pointer shadow-soft disabled:opacity-40">
          {busy ? 'Setting up…' : restoring && info ? 'Start with my backup' : 'Start'}
        </button>
      </div>
    </div>
  );
}
