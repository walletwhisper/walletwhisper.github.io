import { useEffect, useRef, useState } from 'react';
import { Lock, Upload, X } from 'lucide-react';
import clsx from 'clsx';
import type { Summary } from './api';
import { StoreProvider, useFetch, useStore } from './store';
import { useRoute } from './lib';
import type { Screen } from './lib';
import { ImportDialog } from './ImportDialog';
import { Overview } from './screens/Overview';
import { Trends } from './screens/Trends';
import { Transactions } from './screens/Transactions';
import { Review } from './screens/Review';
import { Accounts } from './screens/Accounts';
import { About } from './screens/About';
import { Settings } from './screens/Settings';
import { Setup } from './screens/Setup';
import { api } from './api';
import type { SetupInfo } from './api';
import { boot } from './local/engine';
import { SaveBanner } from './SaveStatus';
import { Segmented } from './ui';

const NAV: { id: Screen; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'trends', label: 'Trends' },
  { id: 'transactions', label: 'Transactions' },
  { id: 'review', label: 'Review' },
  { id: 'accounts', label: 'Accounts' },
  { id: 'settings', label: 'Settings' },
];

function Shell() {
  const { screen, navigate } = useRoute();
  const { message, clearMessage } = useStore();
  const summary = useFetch<Summary>('/api/summary');
  const reviewCount = summary.data?.reviewCount ?? 0;
  const [files, setFiles] = useState<File[] | null>(null);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  // Drop files anywhere on the page
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const enter = (e: DragEvent) => { if (hasFiles(e)) { depth++; setDragging(true); } };
    const leave = () => { depth = Math.max(0, depth - 1); if (depth === 0) setDragging(false); };
    const over = (e: DragEvent) => { if (hasFiles(e)) e.preventDefault(); };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const list = Array.from(e.dataTransfer?.files ?? []).filter(f => /\.csv$/i.test(f.name));
      if (list.length) setFiles(list);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
    };
  }, []);

  return (
    <div className="min-h-screen bg-page text-ink font-sans flex flex-col">
      <header className="sticky top-0 z-40 bg-white/70 backdrop-blur-xl backdrop-saturate-[1.8] border-b border-black/10 px-4 sm:px-6 py-3 flex flex-wrap items-center justify-between gap-3">
        <button onClick={() => navigate('overview')} className="flex items-center gap-2.5 cursor-pointer">
          <Logo />
          <h1 className="text-[21px] font-bold tracking-[-0.4px] text-ink">Wallet<span className="text-accent">Whisper</span></h1>
        </button>
        <nav className="order-3 lg:order-2 w-full lg:w-auto overflow-x-auto">
          <Segmented value={screen === 'about' ? ('' as Screen) : screen} onChange={id => navigate(id)}
            options={NAV.map(n => ({
              id: n.id,
              label: <>{n.label}{n.id === 'review' && reviewCount > 0 && (
                <span className="bg-orange text-white text-[10px] font-bold rounded-full px-1.5 min-w-5 text-center">{reviewCount}</span>
              )}</>,
            }))} />
        </nav>
        <div className="order-2 lg:order-3 flex items-center gap-2">
          <button onClick={() => navigate('about')} title="Where your data is stored"
            className={clsx('hidden sm:flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-full cursor-pointer transition',
              screen === 'about' ? 'bg-good/15 text-good' : 'bg-good/10 text-good hover:bg-good/15')}>
            <Lock className="w-3.5 h-3.5" /> Private · on this computer
          </button>
          <input ref={input} type="file" multiple accept=".csv" className="hidden"
            onChange={e => { const list = Array.from(e.target.files ?? []); if (list.length) setFiles(list); e.target.value = ''; }} />
          <button onClick={() => input.current?.click()}
            className="flex items-center gap-2 bg-accent hover:bg-accent-hover text-white px-4 py-1.5 rounded-full font-medium text-sm cursor-pointer shadow-soft">
            <Upload className="w-4 h-4" /> Import
          </button>
        </div>
      </header>

      <SaveBanner />
      {message && (
        <div className="max-w-7xl w-full mx-auto px-4 sm:px-6 mt-4">
          <div className="p-3 bg-surface shadow-card rounded-[10px] text-sm text-ink flex items-center justify-between gap-3 border-l-4 border-accent">
            <span>{message}</span>
            <button onClick={clearMessage} className="text-muted hover:text-ink cursor-pointer" aria-label="Dismiss"><X className="w-4 h-4" /></button>
          </div>
        </div>
      )}

      <main className="max-w-7xl w-full mx-auto px-4 sm:px-6 py-8 flex-1">
        {screen === 'overview' && <Overview />}
        {screen === 'trends' && <Trends />}
        {screen === 'transactions' && <Transactions />}
        {screen === 'review' && <Review />}
        {screen === 'accounts' && <Accounts />}
        {screen === 'settings' && <Settings />}
        {screen === 'about' && <About />}
      </main>

      <footer className="text-center text-xs text-muted pb-8 px-4">
        <Lock className="w-3 h-3 inline -mt-0.5 mr-1" />
        Your statements and spending stay in this browser, on this computer. Nothing is uploaded.{' '}
        <button onClick={() => navigate('about')} className="text-accent hover:underline cursor-pointer">How your data is stored</button>
      </footer>

      {dragging && (
        <div className="fixed inset-0 z-50 bg-white/80 backdrop-blur-sm border-4 border-dashed border-accent flex flex-col items-center justify-center gap-2 pointer-events-none">
          <p className="text-2xl font-bold tracking-tight text-ink">Drop bank CSV files to import</p>
          <p className="text-sm text-muted">They're read in this browser and never uploaded anywhere.</p>
        </div>
      )}
      {files && <ImportDialog files={files} onClose={() => setFiles(null)} />}
    </div>
  );
}

/** Wallet mark in the SparkFlow palette */
function Logo() {
  return (
    <svg viewBox="0 0 32 32" className="w-8 h-8" aria-hidden="true">
      <rect x="2" y="7" width="28" height="20" rx="6" fill="#005594" />
      <path d="M6 7.5 20.5 3.2a2 2 0 0 1 2.5 1.4L23.6 7" fill="#4398D3" />
      <rect x="19" y="13" width="11" height="8" rx="4" fill="#EE8D3D" />
      <circle cx="23.5" cy="17" r="1.6" fill="#fff" />
    </svg>
  );
}

export function App() {
  const [setup, setSetup] = useState<SetupInfo | null>(null);
  const [elsewhere, setElsewhere] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    boot()
      .then(r => (r.status === 'open-elsewhere' ? setElsewhere(true) : api.get<SetupInfo>('/api/setup').then(setSetup)))
      .catch(e => setError(e.message));
  }, []);

  if (elsewhere) return <Notice>WalletWhisper is already open in another tab. Use that tab, or close it and reload this one.</Notice>;
  if (error) return <Notice>WalletWhisper couldn't start: {error}</Notice>;
  if (!setup) return <div className="min-h-screen bg-page" />;
  if (!setup.configured) return <Setup onDone={() => setSetup({ configured: true })} />;
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen bg-page flex items-center justify-center text-sm text-ink-2 p-4 text-center">{children}</div>;
}

export default App;
