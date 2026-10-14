import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, FileText } from 'lucide-react';
import { api } from './api';
import type { ImportResponse, Preview } from './api';
import { useStore } from './store';
import { Button, Modal, inputClass } from './ui';

/** Preview → pick account (only when unsure) → import. Nothing is written until "Import". */
export function ImportDialog({ files, onClose }: { files: File[]; onClose: () => void }) {
  const { refresh, toast } = useStore();
  const [previews, setPreviews] = useState<Preview[] | null>(null);
  const [choice, setChoice] = useState<Record<string, string>>({}); // filename -> accountId | 'new'
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const form = new FormData();
    files.forEach(f => form.append('files', f));
    api.post<{ previews: Preview[] }>('/api/imports/preview', form)
      .then(d => {
        setPreviews(d.previews);
        setChoice(Object.fromEntries(d.previews.map(p => [p.filename, p.suggestedAccountId ? String(p.suggestedAccountId) : 'new'])));
      })
      .catch(e => setError(e.message));
  }, [files]);

  const importable = (previews || []).filter(p => !p.error);

  const doImport = async () => {
    setBusy(true);
    try {
      const form = new FormData();
      files.filter(f => importable.some(p => p.filename === f.name)).forEach(f => form.append('files', f));
      const choices = Object.fromEntries(importable.map(p => [p.filename, choice[p.filename] === 'new' ? { newAccount: {} } : { accountId: Number(choice[p.filename]) }]));
      form.append('choices', JSON.stringify(choices));
      const res = await api.post<ImportResponse>('/api/imports', form);
      const added = res.results.reduce((a, r) => a + r.rowsAdded, 0);
      const failed = res.results.filter(r => r.error);
      toast(
        `Imported ${added} new transactions` +
        (res.matched.pairsLinked ? ` · ${res.matched.pairsLinked} transfers matched between your accounts` : '') +
        (res.reviewCount ? ` · ${res.reviewCount} items to review` : '') +
        (failed.length ? ` · ${failed.length} file(s) failed: ${failed[0].error}` : '')
      );
      refresh();
      onClose();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Import bank files" onClose={onClose} wide>
      {error && <p className="text-sm text-bad mb-3">{error}</p>}
      {!previews && !error && <p className="text-sm text-muted">Reading files…</p>}
      {previews && (
        <div className="space-y-3">
          {previews.map(p => (
            <div key={p.filename} className="border border-line rounded-lg p-3 bg-page">
              <div className="flex items-center gap-2 text-sm font-medium text-ink">
                <FileText className="w-4 h-4 text-muted" /> {p.filename}
              </div>
              {p.error ? (
                <p className="mt-2 text-xs text-bad flex items-start gap-1.5"><AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />{p.error}</p>
              ) : (
                <>
                  <p className="mt-1.5 text-xs text-ink-2">
                    {p.bank} {p.accountType}{p.last4 ? ` ending ${p.last4}` : ''} · {p.minDate} → {p.maxDate} ·{' '}
                    <span className="text-good font-semibold">{p.newRows} new</span>
                    {p.duplicates ? <span className="text-muted"> · {p.duplicates} already imported (skipped)</span> : null}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                    <span className={p.needsAccountChoice ? 'text-warn' : 'text-muted'}>
                      {p.needsAccountChoice ? 'Which account is this?' : 'Account:'}
                    </span>
                    <select className={inputClass} value={choice[p.filename]} onChange={e => setChoice({ ...choice, [p.filename]: e.target.value })}>
                      {p.accountOptions?.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
                      <option value="new">New account{p.last4 ? ` (${p.bank} ··${p.last4})` : ''}</option>
                    </select>
                  </div>
                </>
              )}
            </div>
          ))}
          <p className="text-xs text-muted flex items-center gap-1.5">
            <CheckCircle2 className="w-3.5 h-3.5 text-good" />
            After importing, transfers between your accounts are matched automatically so nothing is counted twice.
          </p>
          <div className="flex justify-end gap-2 pt-2 border-t border-line">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={busy || importable.length === 0} onClick={doImport}>
              {busy ? 'Importing…' : `Import ${importable.length} file${importable.length === 1 ? '' : 's'}`}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
