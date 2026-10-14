import { useEffect, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { api } from './api';
import { Button, Dot, inputClass } from './ui';

export interface FilterValue { value: string; label: string; color: string | null; count: number }

/**
 * Excel-style column filter: search, tick the values to keep, OK.
 * `selected` null means "no filter" (everything ticked).
 */
export function FilterMenu({ title, valuesUrl, selected, anchor, onApply, onClose }: {
  title: string;
  valuesUrl: string;
  selected: string[] | null;
  anchor: DOMRect;
  onApply: (values: string[] | null) => void;
  onClose: () => void;
}) {
  const [values, setValues] = useState<FilterValue[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.get<{ values: FilterValue[] }>(valuesUrl)
      .then(d => {
        setValues(d.values);
        setChecked(new Set(selected ?? d.values.map(v => v.value)));
      })
      .catch(e => setError(e.message));
  }, [valuesUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  // Close on Escape or a click outside
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const click = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) onClose(); };
    window.addEventListener('keydown', key);
    window.addEventListener('mousedown', click);
    return () => { window.removeEventListener('keydown', key); window.removeEventListener('mousedown', click); };
  }, [onClose]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (values ?? []).filter(v => !q || v.label.toLowerCase().includes(q));
  }, [values, search]);
  const searching = search.trim() !== '';
  const allShownChecked = shown.length > 0 && shown.every(v => checked.has(v.value));

  const toggle = (value: string) => {
    const next = new Set(checked);
    if (next.has(value)) next.delete(value); else next.add(value);
    setChecked(next);
  };
  const toggleAllShown = () => {
    const next = new Set(checked);
    for (const v of shown) { if (allShownChecked) next.delete(v.value); else next.add(v.value); }
    setChecked(next);
  };

  const apply = () => {
    if (!values) return;
    // Like Excel: while searching, OK keeps only the ticked search results
    const keep = (searching ? shown : values).filter(v => checked.has(v.value)).map(v => v.value);
    if (keep.length === 0) return;
    onApply(!searching && keep.length === values.length ? null : keep);
  };

  // Keep the menu on screen
  const width = 288;
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8));
  const top = Math.min(anchor.bottom + 4, window.innerHeight - 380);

  return (
    <div ref={box} role="dialog" aria-label={`Filter ${title}`}
      className="fixed z-50 bg-surface rounded-[12px] shadow-pop border border-line p-3 text-xs normal-case tracking-normal font-normal text-ink"
      style={{ left, top: Math.max(8, top), width }}>
      <p className="font-semibold text-ink mb-2">Filter {title.toLowerCase()}</p>
      <div className="relative">
        <Search className="w-3.5 h-3.5 text-muted absolute left-2.5 top-2" />
        <input autoFocus value={search} onChange={e => setSearch(e.target.value)} placeholder={`Search ${title.toLowerCase()}…`}
          onKeyDown={e => { if (e.key === 'Enter') apply(); }}
          className={`${inputClass} w-full pl-8`} />
      </div>

      {error && <p className="text-bad mt-2">{error}</p>}
      {!values && !error && <p className="text-muted mt-3">Loading…</p>}
      {values && (
        <>
          <label className="flex items-center gap-2 mt-3 pb-2 border-b border-line cursor-pointer font-medium">
            <input type="checkbox" checked={allShownChecked} onChange={toggleAllShown} />
            {searching ? `Select all ${shown.length} results` : 'Select all'}
          </label>
          <ul className="max-h-56 overflow-y-auto py-1">
            {shown.map(v => (
              <li key={v.value}>
                <label className="flex items-center gap-2 py-1 px-0.5 rounded hover:bg-fill cursor-pointer">
                  <input type="checkbox" checked={checked.has(v.value)} onChange={() => toggle(v.value)} />
                  {v.color && <Dot color={v.color} />}
                  <span className="truncate flex-1">{v.label}</span>
                  <span className="text-muted">{v.count}</span>
                </label>
              </li>
            ))}
            {shown.length === 0 && <li className="text-muted py-2">No matches.</li>}
          </ul>
        </>
      )}

      <div className="flex justify-between gap-2 pt-2 border-t border-line">
        <Button variant="ghost" onClick={() => onApply(null)} disabled={selected === null}>Clear filter</Button>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={apply} disabled={!values || shown.every(v => !checked.has(v.value))}>OK</Button>
        </div>
      </div>
    </div>
  );
}
