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

const KEY_EXAMPLES = [
  { name: 'Claude (Anthropic)', site: 'console.anthropic.com', url: 'https://console.anthropic.com/settings/keys', steps: 'Sign in → API keys → Create key', looks: 'sk-ant-…' },
  { name: 'ChatGPT (OpenAI)', site: 'platform.openai.com', url: 'https://platform.openai.com/api-keys', steps: 'Sign in → API keys → Create new secret key', looks: 'sk-…' },
  { name: 'Gemini (Google)', site: 'aistudio.google.com', url: 'https://aistudio.google.com/apikey', steps: 'Sign in → Get API key → Create API key', looks: 'AIza…' },
];

function AiKey({ settings }: { settings: SettingsData }) {
  const { toast, refresh } = useStore();
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const showForm = editing || !settings.aiConfigured;

  const save = async (value: string) => {
    setBusy(true);
    try {
      await api.put('/api/settings/ai', { key: value });
      toast(value ? 'AI is on. Try asking a question on the Overview screen.' : 'AI key removed. AI features are off.');
      setKey('');
      setEditing(false);
      refresh();
    } catch (e: any) { toast(e.message); }
    finally { setBusy(false); }
  };

  return (
    <Card title={<span className="flex items-center gap-2"><Sparkles className="w-4 h-4 text-accent" /> AI assistant (optional)</span>}
      subtitle="WalletWhisper works fully without AI. With your own AI key you can ask questions about your spending and get category suggestions.">
      {!showForm ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-ink flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-good" /> <span><b className="text-good">AI is on.</b> Your key is saved on this computer.</span>
          </p>
          <div className="flex gap-2">
            <Button onClick={() => setEditing(true)}>Change key</Button>
            {!settings.aiKeyInEnvFile && <Button variant="danger" onClick={() => save('')} disabled={busy}>Turn off</Button>}
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div>
            <p className="text-sm font-semibold text-ink">1. Get an API key from an AI provider</p>
            <p className="text-xs text-muted mt-0.5">Any one of these works. Providers charge a small amount per use; asking a question costs a fraction of a cent.</p>
            <ul className="mt-2 grid grid-cols-1 md:grid-cols-3 gap-2">
              {KEY_EXAMPLES.map(x => (
                <li key={x.name} className="rounded-[10px] bg-page p-3 text-xs">
                  <span className="block font-semibold text-ink">{x.name}</span>
                  <a className="text-accent hover:underline" href={x.url} target="_blank" rel="noopener noreferrer">{x.site}</a>
                  <span className="block text-muted mt-1">{x.steps}</span>
                  <span className="block text-muted mt-1">Looks like <code className="text-ink-2">{x.looks}</code></span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className="text-sm font-semibold text-ink">2. Paste it here</p>
            <div className="flex gap-2 mt-2">
              <input type="password" value={key} onChange={e => setKey(e.target.value)} placeholder="Paste your API key"
                autoComplete="off" spellCheck={false} className={`${inputClass} flex-1 !text-sm !py-2`} />
              <Button variant="primary" onClick={() => save(key)} disabled={busy || !key.trim()}>Save</Button>
              {editing && <Button variant="ghost" onClick={() => { setEditing(false); setKey(''); }}>Cancel</Button>}
            </div>
          </div>
          <p className="text-sm text-ink-2">
            <b>3. Use it:</b> ask questions in the box on the Overview and Trends screens, or press <b>AI categorize</b> on Transactions.
          </p>
        </div>
      )}
      <p className="text-xs text-muted mt-4">
        Nothing is sent until you ask a question or press <b>AI categorize</b>. A question sends only your words and the category names.
        Categorizing sends cleaned merchant descriptions and amounts. Account numbers, balances, dates and names are never sent.
      </p>
    </Card>
  );
}
