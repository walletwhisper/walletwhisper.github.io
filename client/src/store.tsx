import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { api } from './api';
import type { Account, Category, Person } from './api';

interface Store {
  categories: Category[];
  people: Person[];
  accounts: Account[];
  /** Increments after every change; screens refetch when it changes. */
  version: number;
  refresh: () => void;
  toast: (message: string) => void;
  message: string | null;
  clearMessage: () => void;
}

const StoreContext = createContext<Store | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [categories, setCategories] = useState<Category[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [version, setVersion] = useState(0);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    api.get<{ categories: Category[] }>('/api/categories').then(d => setCategories(d.categories)).catch(console.error);
  }, []);
  useEffect(() => {
    api.get<{ people: Person[] }>('/api/people').then(d => setPeople(d.people)).catch(console.error);
    api.get<{ accounts: Account[] }>('/api/accounts').then(d => setAccounts(d.accounts)).catch(console.error);
  }, [version]);

  const refresh = useCallback(() => setVersion(v => v + 1), []);
  const toast = useCallback((m: string) => {
    setMessage(m);
    window.setTimeout(() => setMessage(cur => (cur === m ? null : cur)), 7000);
  }, []);

  return (
    <StoreContext.Provider value={{ categories, people, accounts, version, refresh, toast, message, clearMessage: () => setMessage(null) }}>
      {children}
    </StoreContext.Provider>
  );
}

export function useStore(): Store {
  const s = useContext(StoreContext);
  if (!s) throw new Error('useStore outside StoreProvider');
  return s;
}

/** Fetch JSON and refetch when deps or the store version change. */
export function useFetch<T>(url: string | null): { data: T | null; error: string | null; loading: boolean } {
  const { version } = useStore();
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true });
  useEffect(() => {
    if (!url) return;
    let alive = true;
    setState(s => ({ ...s, loading: true }));
    api.get<T>(url)
      .then(data => alive && setState({ data, error: null, loading: false }))
      .catch(err => alive && setState(s => ({ ...s, error: err.message, loading: false })));
    return () => { alive = false; };
  }, [url, version]);
  return state;
}
