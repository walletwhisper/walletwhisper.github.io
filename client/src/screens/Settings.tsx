import { useEffect, useState } from 'react';
import { FolderLock, Sparkles } from 'lucide-react';
import { api } from '../api';
import type { Settings as SettingsData } from '../api';
import { useFetch, useStore } from '../store';
import { Button, Card, inputClass } from '../ui';

export function Settings() {
  const settings = useFetch<SettingsData>('/api/settings').data;
  if (!settings) return null;
  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <DataFolder current={settings.dataFolder} />
      <AiKey settings={settings} />
    </div>
  );
}

function DataFolder({ current }: { current: string | null }) {
  const { toast, refresh } = useStore();
  const [editing, setEditing] = useState(false);
  const [folder, setFolder] = useState(current ?? '');
  const [busy, setBusy] = useState(false);
  useEffect(() => setFolder(current ?? ''), [current]);

  const move = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ oldFolder: string }>('/api/settings/data-folder', { folder });
      toast(`Your data now lives in the new folder. The old copy is still in ${r.oldFolder}; delete it when you're happy.`);
      setEditing(false);
      refresh();
    } catch (e: any) { toast(e.message); }
    finally { setBusy(false); }
  };

  return (
    <Card title={<span className="flex items-center gap-2"><FolderLock className="w-4 h-4 text-accent" /> Your data</span>}
      subtitle="Everything WalletWhisper knows is saved in this folder on this computer, with automatic backups inside it.">
      {current === null ? (
        <p className="text-sm text-muted">Running in test mode, with no data folder.</p>
      ) : editing ? (
        <div className="space-y-3">
          <input value={folder} onChange={e => setFolder(e.target.value)} spellCheck={false} className={`${inputClass} w-full !text-sm !py-2`} />
          <p className="text-xs text-muted">Your data is copied to the new folder. The old folder is left as it is, so nothing is lost.</p>
          <div className="flex gap-2">
            <Button variant="primary" onClick={move} disabled={busy || !folder.trim()}>{busy ? 'Moving…' : 'Move my data here'}</Button>
            <Button variant="ghost" onClick={() => { setEditing(false); setFolder(current ?? ''); }}>Cancel</Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <code className="text-[13px] bg-page text-ink-2 px-2.5 py-1.5 rounded-lg break-all">{current}</code>
          <Button onClick={() => setEditing(true)}>Change folder</Button>
        </div>
      )}
    </Card>
  );
}

function AiKey({ settings }: { settings: SettingsData }) {
  const { toast, refresh } = useStore();
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async (value: string) => {
    setBusy(true);
    try {
      const r = await api.put<{ aiProvider: string | null }>('/api/settings/ai', { key: value });
      toast(value ? `AI turned on with your ${r.aiProvider} key.` : 'AI key removed.');
      setKey('');
      refresh();
    } catch (e: any) { toast(e.message); }
    finally { setBusy(false); }
  };

  return (
    <Card title={<span className="flex items-center gap-2"><Sparkles className="w-4 h-4 text-accent" /> AI categories (optional)</span>}
      subtitle="WalletWhisper works fully without AI. With a key, it can suggest categories for merchants it doesn't recognize.">
      {settings.aiConfigured ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-ink">
            <span className="text-good font-semibold">On</span>, using your {settings.aiProvider} key.
            {settings.aiKeyInEnvFile && <span className="text-muted"> (from the .env file)</span>}
          </p>
          {!settings.aiKeyInEnvFile && <Button variant="danger" onClick={() => save('')} disabled={busy}>Remove key</Button>}
        </div>
      ) : (
        <div className="space-y-3">
          <ol className="text-sm text-ink-2 list-decimal pl-5 space-y-1">
            <li>Create an API key with your AI provider. Claude, Gemini and OpenAI keys work.</li>
            <li>Paste it below and press <b>Save</b>.</li>
            <li>On the Transactions screen, press <b>AI categorize</b> whenever you want suggestions.</li>
          </ol>
          <div className="flex gap-2">
            <input type="password" value={key} onChange={e => setKey(e.target.value)} placeholder="Paste your API key"
              autoComplete="off" spellCheck={false} className={`${inputClass} flex-1 !text-sm !py-2`} />
            <Button variant="primary" onClick={() => save(key)} disabled={busy || !key.trim()}>Save</Button>
          </div>
        </div>
      )}
      <p className="text-xs text-muted mt-4">
        Nothing is sent until you press <b>AI categorize</b>. Then only cleaned merchant descriptions, amounts, account type
        and the bank's category go to your AI provider: never account numbers, balances, dates or names.
        Your key is saved on this computer only.
      </p>
    </Card>
  );
}
