import { useRef, useState } from 'react';
import { Download, Laptop, Upload } from 'lucide-react';
import { downloadBackup, sendBackup } from '../api';
import type { BackupInfo, MergePreview, Summary } from '../api';
import { MergeDialog } from './MergeDialog';
import { useFetch, useStore } from '../store';
import { Button, Card, inputClass } from '../ui';

/** Settings card: export everything to one file, or restore from a file made on another computer. */
export function MoveData() {
  return (
    <Card title={<span className="flex items-center gap-2"><Laptop className="w-4 h-4 text-accent" /> Move to another computer</span>}
      subtitle="Take all your WalletWhisper data to another computer in one file, so you don't have to import your statements again.">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <ExportPart />
        <RestorePart />
      </div>
      <p className="text-xs text-muted mt-5">
        The file holds all your transactions, people, accounts and choices. Your AI key and data folder stay on each computer.
        Keep the file private, like a bank statement.
      </p>
    </Card>
  );
}

function ExportPart() {
  const { toast } = useStore();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const download = async () => {
    setBusy(true);
    try {
      await downloadBackup(password);
      toast(password
        ? 'Backup downloaded and protected with your password. You will need the password to open it.'
        : 'Backup downloaded. Copy it to the other computer and restore it there in Settings.');
      setPassword('');
    } catch (e: any) { toast(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-3">
      <p className="text-sm font-semibold text-ink">1. On this computer: save a backup file</p>
      <label className="block text-xs text-muted">
        Password (optional, recommended if the file goes through email or a cloud drive)
        <input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password"
          placeholder="At least 8 characters" className={`${inputClass} w-full mt-1 !text-sm !py-2`} />
      </label>
      {password && password.length < 8 && <p className="text-xs text-warn">Use at least 8 characters.</p>}
      {password.length >= 8 && <p className="text-xs text-muted">Remember it: the file can't be opened without it, and it can't be recovered.</p>}
      <Button variant="primary" onClick={download} disabled={busy || (!!password && password.length < 8)}>
        <Download className="w-3.5 h-3.5" /> {busy ? 'Preparing…' : 'Download backup file'}
      </Button>
    </div>
  );
}

function RestorePart() {
  const { toast } = useStore();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState('');
  const [needsPassword, setNeedsPassword] = useState(false);
  const [info, setInfo] = useState<BackupInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [comparison, setComparison] = useState<{ compareId: string | null; preview: MergePreview } | null>(null);
  // With data already here, a backup is compared first so nothing is overwritten without asking
  const hasData = !!useFetch<Summary>('/api/summary').data?.dataRange.max;

  const compare = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      setComparison(await sendBackup<{ compareId: string | null; preview: MergePreview }>('compare', file, password));
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  };

  const inspect = async (f: File, pw: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = await sendBackup<{ needsPassword: boolean; info?: BackupInfo }>('inspect', f, pw);
      setNeedsPassword(r.needsPassword);
      setInfo(r.info ?? null);
    } catch (e: any) { setError(e.message); setInfo(null); }
    finally { setBusy(false); }
  };

  const restore = async () => {
    if (!file) return;
    setBusy(true);
    try {
      await sendBackup('restore', file, password, true);
      toast('Backup restored.');
      window.location.reload(); // every screen starts fresh with the restored data
    } catch (e: any) { setError(e.message); setBusy(false); }
  };

  const reset = () => { setFile(null); setInfo(null); setNeedsPassword(false); setPassword(''); setError(null); };

  return (
    <div className="space-y-3">
      <p className="text-sm font-semibold text-ink">2. On the other computer: restore it</p>
      <input ref={input} type="file" accept=".wwbackup,.db" className="hidden"
        onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) { reset(); setFile(f); inspect(f, ''); } }} />
      {!file ? (
        <>
          <p className="text-xs text-muted">Choose a <code>.wwbackup</code> file made by WalletWhisper.</p>
          <Button onClick={() => input.current?.click()}><Upload className="w-3.5 h-3.5" /> Choose backup file</Button>
        </>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-ink-2 break-all"><b>{file.name}</b> · <button className="text-accent hover:underline cursor-pointer" onClick={reset}>choose another</button></p>
          {needsPassword && !info && (
            <div className="flex gap-2">
              <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Backup password"
                onKeyDown={e => { if (e.key === 'Enter' && password) inspect(file, password); }}
                className={`${inputClass} flex-1 !text-sm !py-2`} autoFocus />
              <Button onClick={() => inspect(file, password)} disabled={busy || !password}>Unlock</Button>
            </div>
          )}
          {info && (
            <div className="rounded-[10px] bg-page p-3 text-xs space-y-2">
              <p className="text-ink">
                This backup has <b>{info.transactions.toLocaleString()} transactions</b>
                {info.from && <> from {info.from} to {info.to}</>}, {info.accounts} account{info.accounts === 1 ? '' : 's'} and {info.people} {info.people === 1 ? 'person' : 'people'}.
              </p>
              {hasData ? (
                <>
                  <p className="text-ink-2">You already have data here. WalletWhisper will show what's different and let you combine the two or use the backup.</p>
                  <Button variant="primary" onClick={compare} disabled={busy}>{busy ? 'Comparing…' : 'Compare with my data'}</Button>
                </>
              ) : (
                <>
                  <p className="text-ink-2">There's no data on this computer yet, so the backup will simply be loaded.</p>
                  <Button variant="primary" onClick={restore} disabled={busy}>{busy ? 'Restoring…' : 'Load this backup'}</Button>
                </>
              )}
            </div>
          )}
          {busy && !info && <p className="text-xs text-muted">Checking the file…</p>}
        </div>
      )}
      {error && <p className="text-xs text-bad">{error}</p>}
      {comparison && info && file && (
        <MergeDialog compareId={comparison.compareId} preview={comparison.preview} info={info} file={file} password={password}
          onClose={() => setComparison(null)} />
      )}
    </div>
  );
}
