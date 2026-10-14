import { useState } from 'react';
import { FolderLock } from 'lucide-react';
import { api } from '../api';
import { inputClass } from '../ui';

/** First run: the user chooses the folder on this computer where WalletWhisper keeps its data. */
export function Setup({ suggestedFolder, onDone }: { suggestedFolder: string; onDone: () => void }) {
  const [folder, setFolder] = useState(suggestedFolder);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/setup', { folder });
      onDone();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

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

        {error && <p className="mt-4 text-sm text-bad">{error}</p>}

        <button onClick={start} disabled={busy || !folder.trim()}
          className="mt-6 w-full bg-accent hover:bg-accent-hover text-white rounded-full py-2.5 font-semibold text-sm cursor-pointer shadow-soft disabled:opacity-40">
          {busy ? 'Setting up…' : 'Start'}
        </button>
      </div>
    </div>
  );
}
