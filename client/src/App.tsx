import { useEffect, useRef, useState } from 'react';
import { DollarSign, Upload, X } from 'lucide-react';
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

const NAV: { id: Screen; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'trends', label: 'Trends' },
  { id: 'transactions', label: 'Transactions' },
  { id: 'review', label: 'Review' },
  { id: 'accounts', label: 'Accounts' },
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
    <div className="min-h-screen bg-slate-900 text-slate-100 font-sans pb-16">
      <header className="border-b border-slate-800 bg-slate-900/95 backdrop-blur sticky top-0 z-40 px-4 sm:px-6 py-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="bg-indigo-600 p-2 rounded-lg text-white"><DollarSign className="w-5 h-5" /></div>
          <h1 className="text-lg font-bold tracking-tight text-white">Spending Analyzer</h1>
        </div>
        <nav className="flex flex-wrap gap-1 text-sm order-3 sm:order-2 w-full sm:w-auto">
          {NAV.map(n => (
            <button key={n.id} onClick={() => navigate(n.id)}
              className={clsx('px-3 py-1.5 rounded-lg cursor-pointer flex items-center gap-1.5',
                screen === n.id ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-white hover:bg-slate-800')}>
              {n.label}
              {n.id === 'review' && reviewCount > 0 && (
                <span className="bg-amber-500 text-slate-900 text-[10px] font-bold rounded-full px-1.5 min-w-5 text-center">{reviewCount}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="order-2 sm:order-3">
          <input ref={input} type="file" multiple accept=".csv" className="hidden"
            onChange={e => { const list = Array.from(e.target.files ?? []); if (list.length) setFiles(list); e.target.value = ''; }} />
          <button onClick={() => input.current?.click()}
            className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-lg font-medium text-sm cursor-pointer">
            <Upload className="w-4 h-4" /> Import
          </button>
        </div>
      </header>

      {message && (
        <div className="max-w-7xl mx-auto px-4 sm:px-6 mt-4">
          <div className="p-3 bg-indigo-900/80 border border-indigo-700 text-indigo-100 rounded-lg text-sm flex items-center justify-between gap-3">
            <span>{message}</span>
            <button onClick={clearMessage} className="text-indigo-300 hover:text-white cursor-pointer" aria-label="Dismiss"><X className="w-4 h-4" /></button>
          </div>
        </div>
      )}

      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-6">
        {screen === 'overview' && <Overview />}
        {screen === 'trends' && <Trends />}
        {screen === 'transactions' && <Transactions />}
        {screen === 'review' && <Review />}
        {screen === 'accounts' && <Accounts />}
      </main>

      {dragging && (
        <div className="fixed inset-0 z-50 bg-indigo-950/80 border-4 border-dashed border-indigo-400 flex items-center justify-center pointer-events-none">
          <p className="text-2xl font-semibold text-white">Drop bank CSV files to import</p>
        </div>
      )}
      {files && <ImportDialog files={files} onClose={() => setFiles(null)} />}
    </div>
  );
}

export function App() {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  );
}

export default App;
