import { useRef, useState } from 'react';
import { FileUp, FolderOpen, Lock, Sparkles } from 'lucide-react';
import { api, sendBackup } from '../api';
import type { BackupInfo } from '../api';
import { reloadWhenSaved, saveNow } from '../local/engine';
import { chooseFolder, folderSupported, linkFolder, readFolderFile } from '../local/folder';
import { inputClass } from '../ui';
import { markBackedUp } from '../SaveStatus';

/**
 * First visit in this browser: start fresh, bring data from a backup file, or (Chrome/Edge) use a
 * folder on this computer that also keeps a copy of the data.
 */
export function Setup({ onDone }: { onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState('');
  const [needsPassword, setNeedsPassword] = useState(false);
  const [info, setInfo] = useState<BackupInfo | null>(null);
  const [pendingFolder, setPendingFolder] = useState<FileSystemDirectoryHandle | null>(null);

  const guard = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await fn(); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  const startFresh = () => guard(async () => {
    await api.post('/api/setup');
    await saveNow();
    onDone();
  });

  const inspect = (f: File, pw: string) => guard(async () => {
    const r = await sendBackup<{ needsPassword: boolean; info?: BackupInfo }>('inspect', f, pw);
    setNeedsPassword(r.needsPassword);
    setInfo(r.info ?? null);
  });

  const pickFile = (f: File, folder: FileSystemDirectoryHandle | null = null) => {
    setFile(f); setInfo(null); setPassword(''); setNeedsPassword(false); setPendingFolder(folder);
    inspect(f, '');
  };

  const restore = () => guard(async () => {
    if (!file) return;
    await sendBackup('restore', file, password);
    await markBackedUp(); // they have this backup file
    if (pendingFolder) await linkFolder(pendingFolder);
    await reloadWhenSaved();
  });

  const useFolder = () => guard(async () => {
    const dir = await chooseFolder();
    if (!dir) return;
    const existing = await readFolderFile(dir);
    if (existing) { pickFile(existing, dir); return; } // data from before: open it
    await linkFolder(dir);
    await api.post('/api/setup');
    await saveNow(); // writes the first copy into the folder
    onDone();
  });

  return (
    <div className="min-h-screen bg-page font-sans flex items-center justify-center p-4">
      <div className="bg-surface rounded-card shadow-card w-full max-w-lg p-8">
        <h1 className="text-[28px] font-extrabold tracking-[-0.5px] text-ink">
          Welcome to Wallet<span className="text-accent">Whisper</span>
        </h1>
        <p className="text-[15px] text-ink-2 mt-2 leading-relaxed">
          See where your household's money goes, from the CSV statements your banks give you.
        </p>
        <div className="mt-4 flex gap-3 rounded-[10px] bg-good/10 p-3 text-[13px] text-ink-2 leading-relaxed">
          <Lock className="w-4 h-4 min-w-4 mt-0.5 text-good" />
          <span>
            <b className="text-ink">Your data stays on this computer.</b> WalletWhisper runs entirely in this browser and has no server:
            your statements are read here and saved here, in this browser's private storage. Nothing is uploaded.
          </span>
        </div>

        {!file ? (
          <div className="mt-6 space-y-3">
            <button onClick={startFresh} disabled={busy}
              className="w-full bg-accent hover:bg-accent-hover text-white rounded-full py-2.5 font-semibold text-sm cursor-pointer shadow-soft disabled:opacity-40 flex items-center justify-center gap-2">
              <Sparkles className="w-4 h-4" /> {busy ? 'Setting up…' : 'Start'}
            </button>
            <input ref={fileInput} type="file" accept=".wwbackup,.db" className="hidden"
              onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) pickFile(f); }} />
            <Choice icon={<FileUp className="w-4 h-4" />} onClick={() => fileInput.current?.click()} disabled={busy}
              title="I have a backup file"
              desc="Made with Settings → Download backup file, on another computer or browser." />
            {folderSupported() && (
              <Choice icon={<FolderOpen className="w-4 h-4" />} onClick={useFolder} disabled={busy}
                title="Also keep my data in a folder"
                desc="Choose a folder on this computer. WalletWhisper saves a copy there after every change, and opens it if it's already there." />
            )}
          </div>
        ) : (
          <div className="mt-6 space-y-3 text-sm">
            <p className="text-ink-2 break-all">
              <b className="text-ink">{file.name}</b> · <button className="text-accent hover:underline cursor-pointer" onClick={() => setFile(null)}>back</button>
            </p>
            {needsPassword && !info && (
              <div className="flex gap-2">
                <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Backup password" autoFocus
                  onKeyDown={e => { if (e.key === 'Enter' && password) inspect(file, password); }}
                  className={`${inputClass} flex-1 !text-sm !py-2`} />
                <button onClick={() => inspect(file, password)} disabled={!password || busy}
                  className="text-accent font-medium cursor-pointer disabled:opacity-40">Unlock</button>
              </div>
            )}
            {info && (
              <>
                <p className="text-ink-2">
                  Ready: {info.transactions.toLocaleString()} transactions{info.from && <> ({info.from} to {info.to})</>}, {info.accounts} accounts, {info.people} people.
                </p>
                <button onClick={restore} disabled={busy}
                  className="w-full bg-accent hover:bg-accent-hover text-white rounded-full py-2.5 font-semibold text-sm cursor-pointer shadow-soft disabled:opacity-40">
                  {busy ? 'Opening…' : 'Start with this data'}
                </button>
              </>
            )}
            {busy && !info && <p className="text-xs text-muted">Checking the file…</p>}
          </div>
        )}

        {error && <p className="mt-4 text-sm text-bad">{error}</p>}
      </div>
    </div>
  );
}

function Choice({ icon, title, desc, onClick, disabled }: { icon: React.ReactNode; title: string; desc: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button onClick={onClick} disabled={disabled}
      className="w-full text-left flex gap-3 rounded-[10px] border border-line p-3 hover:border-accent/50 hover:bg-accent/5 cursor-pointer transition disabled:opacity-40">
      <span className="w-8 h-8 min-w-8 rounded-full bg-accent/10 text-accent flex items-center justify-center">{icon}</span>
      <span>
        <span className="block text-sm font-semibold text-ink">{title}</span>
        <span className="block text-xs text-muted mt-0.5">{desc}</span>
      </span>
    </button>
  );
}
