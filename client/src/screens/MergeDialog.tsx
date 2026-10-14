import { useState } from 'react';
import { GitMerge, Replace } from 'lucide-react';
import { api, sendBackup } from '../api';
import type { BackupInfo, MergeConflict, MergePreview } from '../api';
import { formatCents } from '../lib';
import { Button, Modal } from '../ui';

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : null;

/**
 * Shown when restoring onto a computer that already has data: what differs, and the choice to
 * combine both (resolving any conflicts) or replace everything with the backup.
 */
export function MergeDialog({ compareId, preview, info, file, password, onClose }: {
  compareId: string | null;
  preview: MergePreview;
  info: BackupInfo;
  file: File;
  password: string;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<'combine' | 'replace'>('combine');
  const [choices, setChoices] = useState<Record<string, 'mine' | 'theirs'>>(
    Object.fromEntries(preview.conflicts.map(c => [c.id, c.suggested])));
  const [removeLocalOnly, setRemoveLocalOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setAll = (pick: (c: MergeConflict) => 'mine' | 'theirs') =>
    setChoices(Object.fromEntries(preview.conflicts.map(c => [c.id, pick(c)])));

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      if (mode === 'combine') await api.post('/api/backup/merge', { compareId, choices, removeLocalOnly });
      else await sendBackup('restore', file, password, true);
      window.location.reload();
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  };

  if (preview.identical) {
    return (
      <Modal title="Nothing to combine" onClose={onClose}>
        <p className="text-sm text-ink-2">This backup has exactly the same data as this computer, so there's nothing to change.</p>
        <div className="flex justify-end mt-5"><Button variant="primary" onClick={onClose}>OK</Button></div>
      </Modal>
    );
  }

  const facts = [
    preview.newTransactions > 0 && `${preview.newTransactions.toLocaleString()} transactions only in the backup`,
    preview.localOnlyTransactions > 0 && `${preview.localOnlyTransactions.toLocaleString()} transactions only on this computer`,
    preview.newPeople.length > 0 && `New people: ${preview.newPeople.join(', ')}`,
    preview.newAccounts.length > 0 && `New accounts: ${preview.newAccounts.join(', ')}`,
    preview.newRules > 0 && `${preview.newRules} new remembered rule${preview.newRules === 1 ? '' : 's'}`,
    preview.editsFromBackup > 0 && `${preview.editsFromBackup} change${preview.editsFromBackup === 1 ? '' : 's'} made only on the other computer`,
    preview.conflicts.length > 0 && `${preview.conflicts.length} conflict${preview.conflicts.length === 1 ? '' : 's'}: changed differently on both computers`,
  ].filter(Boolean) as string[];

  return (
    <Modal title="This backup is different from the data here" onClose={onClose} wide>
      <div className="space-y-5 text-sm">
        <div>
          <p className="text-ink-2">
            The backup has {info.transactions.toLocaleString()} transactions{info.from && <> ({info.from} to {info.to})</>}. Compared with this computer:
          </p>
          <ul className="mt-2 space-y-1 text-ink list-disc pl-5">{facts.map(f => <li key={f}>{f}</li>)}</ul>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Option active={mode === 'combine'} onClick={() => setMode('combine')} icon={<GitMerge className="w-4 h-4" />}
            title="Combine both (recommended)"
            desc="Keep everything from both computers. Changes made on only one side come across automatically; you decide each conflict." />
          <Option active={mode === 'replace'} onClick={() => setMode('replace')} icon={<Replace className="w-4 h-4" />}
            title="Use the backup instead"
            desc="Replace everything on this computer with the backup. Anything only on this computer is dropped." />
        </div>

        {mode === 'combine' && preview.conflicts.length > 0 && (
          <div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-semibold text-ink">Resolve conflicts</p>
              <div className="flex flex-wrap gap-1.5">
                <Button variant="ghost" onClick={() => setAll(c => c.suggested)}>Use newer for all</Button>
                <Button variant="ghost" onClick={() => setAll(() => 'mine')}>Keep this computer's for all</Button>
                <Button variant="ghost" onClick={() => setAll(() => 'theirs')}>Use backup's for all</Button>
              </div>
            </div>
            <ul className="mt-2 divide-y divide-line border border-line rounded-[10px] max-h-80 overflow-y-auto">
              {preview.conflicts.map(c => (
                <li key={c.id} className="p-3">
                  <p className="text-xs text-muted">{c.detail}{c.detail && ' · '}{c.field}</p>
                  <p className="font-medium text-ink">{c.title}</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-2">
                    <Choice active={choices[c.id] === 'mine'} onClick={() => setChoices({ ...choices, [c.id]: 'mine' })}
                      label="This computer" value={c.mine} changed={when(c.mineChangedAt)} newer={c.suggested === 'mine' && !!c.mineChangedAt} />
                    <Choice active={choices[c.id] === 'theirs'} onClick={() => setChoices({ ...choices, [c.id]: 'theirs' })}
                      label="Backup" value={c.theirs} changed={when(c.theirsChangedAt)} newer={c.suggested === 'theirs' && !!c.theirsChangedAt} />
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {mode === 'combine' && preview.localOnlyTransactions > 0 && (
          <label className="flex items-start gap-2 text-ink-2 cursor-pointer">
            <input type="checkbox" className="mt-1" checked={removeLocalOnly} onChange={e => setRemoveLocalOnly(e.target.checked)} />
            <span>
              Also remove the {preview.localOnlyTransactions} transaction{preview.localOnlyTransactions === 1 ? '' : 's'} that aren't in the backup
              (only if you deleted or undid them on the other computer). For example:{' '}
              <span className="text-muted">{preview.localOnlySample.map(s => `${s.merchant} ${formatCents(s.amountCents)} on ${s.date}`).join('; ')}</span>
            </span>
          </label>
        )}

        <p className="text-xs text-muted">Either way, a copy of this computer's current data is saved in its backups folder first.</p>
        {error && <p className="text-bad">{error}</p>}

        <div className="flex justify-end gap-2 pt-3 border-t border-line">
          <Button variant="ghost" onClick={onClose}>Cancel, keep my data</Button>
          <Button variant="primary" onClick={run} disabled={busy}>
            {busy ? 'Working…' : mode === 'combine' ? 'Combine' : 'Replace with backup'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function Option({ active, onClick, icon, title, desc }: { active: boolean; onClick: () => void; icon: React.ReactNode; title: string; desc: string }) {
  return (
    <button onClick={onClick}
      className={`text-left rounded-[10px] p-3 border-2 cursor-pointer transition ${active ? 'border-accent bg-accent/5' : 'border-line hover:border-accent/40'}`}>
      <span className="flex items-center gap-2 font-semibold text-ink">{icon}{title}</span>
      <span className="block text-xs text-muted mt-1">{desc}</span>
    </button>
  );
}

function Choice({ active, onClick, label, value, changed, newer }: {
  active: boolean; onClick: () => void; label: string; value: string; changed: string | null; newer: boolean;
}) {
  return (
    <button onClick={onClick}
      className={`text-left rounded-lg px-3 py-2 border cursor-pointer text-xs ${active ? 'border-accent bg-accent/5' : 'border-line hover:bg-fill/60'}`}>
      <span className="flex items-center gap-2">
        <input type="radio" readOnly checked={active} className="pointer-events-none" />
        <span className="text-muted">{label}</span>
        {newer && <span className="text-[10px] font-semibold text-accent uppercase tracking-wide">Newer</span>}
      </span>
      <span className="block text-sm font-medium text-ink mt-1">{value}</span>
      {changed && <span className="block text-muted mt-0.5">Changed {changed}</span>}
    </button>
  );
}
