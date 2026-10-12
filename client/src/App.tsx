import { useState, useEffect, useRef } from 'react';
import {
  PieChart, Pie, Cell, ResponsiveContainer, Tooltip,
  BarChart, Bar, XAxis, YAxis
} from 'recharts';
import {
  Upload, DollarSign, TrendingUp, CreditCard,
  Search, X, Check, Calendar
} from 'lucide-react';

interface CategoryItem {
  id: number;
  name: string;
  color: string;
  cents: number;
  count: number;
  pct: number;
}

interface MonthItem {
  month: string;
  cents: number;
}

interface SummaryData {
  totalSpend: number;
  moneyIn: number;
  totalTxnCount: number;
  byCategory: CategoryItem[];
  byMonth: MonthItem[];
}

interface TransactionItem {
  id: number;
  date: string;
  rawDescription: string;
  merchant: string;
  amountCents: number;
  kind: string;
  categoryId: number;
  categorySource: string;
  bankCategory?: string;
  categoryName: string;
  categoryColor: string;
  bank: string;
  accountType: string;
}

interface CategoryOption {
  id: number;
  name: string;
  color: string;
}

export function App() {
  const [summary, setSummary] = useState<SummaryData | null>(null);
  const [categories, setCategories] = useState<CategoryOption[]>([]);
  const [transactions, setTransactions] = useState<TransactionItem[]>([]);
  const [txnCount, setTxnCount] = useState(0);
  const [txnSumCents, setTxnSumCents] = useState(0);

  // Filters
  const [selectedCategory, setSelectedCategory] = useState<CategoryItem | null>(null);
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null);
  const [dateRange, setDateRange] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');

  // UI state
  const [isUploading, setIsUploading] = useState(false);
  const [uploadToast, setUploadToast] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Recategorize modal / inline state
  const [editingTxn, setEditingTxn] = useState<TransactionItem | null>(null);
  const [newCatId, setNewCatId] = useState<number>(0);
  const [rememberRule, setRememberRule] = useState(true);

  // Fetch categories once
  useEffect(() => {
    fetch('/api/categories')
      .then(r => r.json())
      .then(d => setCategories(d.categories || []))
      .catch(console.error);
  }, []);

  // Compute date from/to based on dateRange
  const getDateParams = () => {
    const now = new Date();
    let from: string | undefined;
    let to: string | undefined;

    if (dateRange === 'this_month') {
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, '0');
      from = `${year}-${month}-01`;
    } else if (dateRange === 'last_30') {
      const past = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      from = past.toISOString().split('T')[0];
    } else if (dateRange === 'ytd') {
      from = `${now.getFullYear()}-01-01`;
    }
    return { from, to };
  };

  const fetchSummary = () => {
    const { from, to } = getDateParams();
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);

    fetch(`/api/summary?${params.toString()}`)
      .then(r => r.json())
      .then(setSummary)
      .catch(console.error);
  };

  const fetchTransactions = () => {
    const { from, to } = getDateParams();
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    if (selectedCategory) params.set('categoryId', String(selectedCategory.id));
    if (selectedMonth) params.set('month', selectedMonth);
    if (searchQuery) params.set('q', searchQuery);

    fetch(`/api/transactions?${params.toString()}`)
      .then(r => r.json())
      .then(d => {
        setTransactions(d.transactions || []);
        setTxnCount(d.count || 0);
        setTxnSumCents(d.sumCents || 0);
      })
      .catch(console.error);
  };

  useEffect(() => {
    fetchSummary();
  }, [dateRange]);

  useEffect(() => {
    fetchTransactions();
  }, [dateRange, selectedCategory, selectedMonth, searchQuery]);

  const handleFileUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setIsUploading(true);

    const formData = new FormData();
    for (let i = 0; i < files.length; i++) {
      formData.append('files', files[i]);
    }

    try {
      const res = await fetch('/api/imports', {
        method: 'POST',
        body: formData
      });
      const data = await res.json();
      if (data.results) {
        const added = data.results.reduce((acc: number, r: any) => acc + (r.rowsAdded || 0), 0);
        const skipped = data.results.reduce((acc: number, r: any) => acc + (r.rowsSkipped || 0), 0);
        setUploadToast(`Import completed: ${added} added, ${skipped} duplicate/skipped.`);
      } else if (data.error) {
        setUploadToast(`Upload failed: ${data.error}`);
      }
      fetchSummary();
      fetchTransactions();
    } catch (err: any) {
      setUploadToast(`Error uploading: ${err.message}`);
    } finally {
      setIsUploading(false);
      setTimeout(() => setUploadToast(null), 5000);
    }
  };

  const handleCategorySelect = (entry: CategoryItem) => {
    if (selectedCategory?.id === entry.id) {
      setSelectedCategory(null);
    } else {
      setSelectedCategory(entry);
    }
  };

  const handleSaveCategoryChange = async () => {
    if (!editingTxn || !newCatId) return;

    try {
      await fetch(`/api/transactions/${editingTxn.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ categoryId: newCatId, remember: rememberRule })
      });
      setEditingTxn(null);
      fetchSummary();
      fetchTransactions();
    } catch (err) {
      console.error(err);
    }
  };

  const formatCents = (cents: number) => {
    const dollars = cents / 100;
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(dollars);
  };

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 font-sans pb-16">
      {/* Top Navbar */}
      <header className="border-b border-slate-800 bg-slate-900/90 backdrop-blur sticky top-0 z-40 px-6 py-4 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="bg-indigo-600 p-2 rounded-lg text-white">
            <DollarSign className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-white">Financial Characterizer</h1>
            <p className="text-xs text-slate-400">Personal Spending & Multi-Bank Visualizer</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Date Filter selector */}
          <div className="flex items-center bg-slate-800 border border-slate-700 rounded-lg px-3 py-1.5 text-sm">
            <Calendar className="w-4 h-4 text-slate-400 mr-2" />
            <select
              value={dateRange}
              onChange={e => setDateRange(e.target.value)}
              className="bg-transparent text-slate-200 focus:outline-none cursor-pointer"
            >
              <option value="all">All Time</option>
              <option value="this_month">This Month</option>
              <option value="last_30">Last 30 Days</option>
              <option value="ytd">Year to Date</option>
            </select>
          </div>

          {/* Hidden file input */}
          <input
            type="file"
            ref={fileInputRef}
            onChange={e => handleFileUpload(e.target.files)}
            multiple
            accept=".csv"
            className="hidden"
          />

          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={isUploading}
            className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-lg font-medium text-sm transition shadow-sm cursor-pointer"
          >
            <Upload className="w-4 h-4" />
            {isUploading ? 'Importing...' : 'Import Bank CSVs'}
          </button>
        </div>
      </header>

      {/* Upload Toast notification */}
      {uploadToast && (
        <div className="mx-6 mt-4 p-3 bg-indigo-900/80 border border-indigo-700 text-indigo-100 rounded-lg text-sm flex items-center justify-between shadow-lg">
          <span>{uploadToast}</span>
          <button onClick={() => setUploadToast(null)} className="text-indigo-300 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      <main className="max-w-7xl mx-auto px-6 py-8 space-y-8">
        {/* KPI Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="bg-slate-800/60 border border-slate-700/60 rounded-xl p-5 shadow-sm">
            <div className="flex items-center justify-between text-slate-400 text-sm font-medium">
              <span>Total Spending</span>
              <DollarSign className="w-4 h-4 text-emerald-400" />
            </div>
            <div className="mt-2 text-2xl font-bold text-white">
              {formatCents(summary?.totalSpend || 0)}
            </div>
            <div className="mt-1 text-xs text-slate-400">Excludes transfers & payments</div>
          </div>

          <div className="bg-slate-800/60 border border-slate-700/60 rounded-xl p-5 shadow-sm">
            <div className="flex items-center justify-between text-slate-400 text-sm font-medium">
              <span>Money In (Income)</span>
              <TrendingUp className="w-4 h-4 text-green-400" />
            </div>
            <div className="mt-2 text-2xl font-bold text-green-400">
              {formatCents(summary?.moneyIn || 0)}
            </div>
            <div className="mt-1 text-xs text-slate-400">Deposits & salary</div>
          </div>

          <div className="bg-slate-800/60 border border-slate-700/60 rounded-xl p-5 shadow-sm">
            <div className="flex items-center justify-between text-slate-400 text-sm font-medium">
              <span>Top Category</span>
              <CreditCard className="w-4 h-4 text-amber-400" />
            </div>
            <div className="mt-2 text-2xl font-bold text-amber-300">
              {summary?.byCategory?.[0]?.name || 'N/A'}
            </div>
            <div className="mt-1 text-xs text-slate-400">
              {summary?.byCategory?.[0] ? `${formatCents(summary.byCategory[0].cents)} (${summary.byCategory[0].pct}%)` : 'No data'}
            </div>
          </div>

          <div className="bg-slate-800/60 border border-slate-700/60 rounded-xl p-5 shadow-sm">
            <div className="flex items-center justify-between text-slate-400 text-sm font-medium">
              <span>Total Transactions</span>
              <Calendar className="w-4 h-4 text-indigo-400" />
            </div>
            <div className="mt-2 text-2xl font-bold text-white">
              {summary?.totalTxnCount || 0}
            </div>
            <div className="mt-1 text-xs text-slate-400">Normalized records</div>
          </div>
        </div>

        {/* Visual Charts Row */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          {/* Category Donut Chart */}
          <div className="bg-slate-800/60 border border-slate-700/60 rounded-xl p-6 shadow-sm flex flex-col">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-base font-semibold text-white">Spending by Category</h2>
                <p className="text-xs text-slate-400">Hover for details • Click slice to filter table</p>
              </div>
              {selectedCategory && (
                <button
                  onClick={() => setSelectedCategory(null)}
                  className="text-xs flex items-center gap-1 bg-slate-700 hover:bg-slate-600 text-slate-200 px-2 py-1 rounded cursor-pointer"
                >
                  <X className="w-3 h-3" /> Reset Filter
                </button>
              )}
            </div>

            <div className="h-72 w-full flex items-center justify-center">
              {summary?.byCategory && summary.byCategory.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={summary.byCategory}
                      dataKey="cents"
                      nameKey="name"
                      cx="50%"
                      cy="50%"
                      innerRadius={70}
                      outerRadius={105}
                      paddingAngle={3}
                      cursor="pointer"
                      onClick={(_, index) => handleCategorySelect(summary.byCategory[index])}
                    >
                      {summary.byCategory.map(entry => (
                        <Cell
                          key={`cell-${entry.id}`}
                          fill={entry.color}
                          stroke={selectedCategory?.id === entry.id ? '#ffffff' : 'transparent'}
                          strokeWidth={selectedCategory?.id === entry.id ? 3 : 1}
                          opacity={selectedCategory && selectedCategory.id !== entry.id ? 0.35 : 1}
                        />
                      ))}
                    </Pie>
                    <Tooltip
                      content={({ active, payload }) => {
                        if (active && payload && payload.length) {
                          const data = payload[0].payload as CategoryItem;
                          return (
                            <div className="bg-slate-800 border border-slate-600 px-3 py-2 rounded-lg shadow-xl text-xs">
                              <p className="font-bold text-white flex items-center gap-2">
                                <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: data.color }} />
                                {data.name}
                              </p>
                              <p className="text-slate-300 mt-1 font-semibold">{formatCents(data.cents)} ({data.pct}%)</p>
                              <p className="text-slate-400 mt-0.5">{data.count} transactions</p>
                            </div>
                          );
                        }
                        return null;
                      }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              ) : (
                <div className="text-center text-slate-500 text-sm">
                  No spending data. Drop a bank CSV above!
                </div>
              )}
            </div>

            {/* Category Pills below Donut */}
            <div className="mt-4 flex flex-wrap gap-2 max-h-24 overflow-y-auto pr-1">
              {summary?.byCategory.map(cat => (
                <button
                  key={cat.id}
                  onClick={() => handleCategorySelect(cat)}
                  className={`text-xs px-2.5 py-1 rounded-full flex items-center gap-1.5 transition cursor-pointer border ${
                    selectedCategory?.id === cat.id
                      ? 'bg-slate-700 text-white border-white'
                      : 'bg-slate-800/80 text-slate-300 border-slate-700 hover:border-slate-500'
                  }`}
                >
                  <span className="w-2 h-2 rounded-full" style={{ backgroundColor: cat.color }} />
                  <span>{cat.name}</span>
                  <span className="text-slate-400 font-mono">{formatCents(cat.cents)}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Monthly Trend Bar Chart */}
          <div className="bg-slate-800/60 border border-slate-700/60 rounded-xl p-6 shadow-sm flex flex-col">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-base font-semibold text-white">Monthly Spending Trend</h2>
                <p className="text-xs text-slate-400">Click bar to filter to specific month</p>
              </div>
              {selectedMonth && (
                <button
                  onClick={() => setSelectedMonth(null)}
                  className="text-xs flex items-center gap-1 bg-slate-700 hover:bg-slate-600 text-slate-200 px-2 py-1 rounded cursor-pointer"
                >
                  <X className="w-3 h-3" /> Clear Month ({selectedMonth})
                </button>
              )}
            </div>

            <div className="h-72 w-full flex items-center justify-center">
              {summary?.byMonth && summary.byMonth.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={summary.byMonth} onClick={e => {
                    if (e?.activeLabel) {
                      const label = String(e.activeLabel);
                      setSelectedMonth(selectedMonth === label ? null : label);
                    }
                  }}>
                    <XAxis dataKey="month" stroke="#94a3b8" fontSize={12} />
                    <YAxis
                      stroke="#94a3b8"
                      fontSize={12}
                      tickFormatter={val => `$${val / 100}`}
                    />
                    <Tooltip
                      content={({ active, payload }) => {
                        if (active && payload && payload.length) {
                          const data = payload[0].payload as MonthItem;
                          return (
                            <div className="bg-slate-800 border border-slate-600 px-3 py-2 rounded-lg shadow-xl text-xs">
                              <p className="font-bold text-white">{data.month}</p>
                              <p className="text-emerald-400 font-semibold mt-1">{formatCents(data.cents)}</p>
                            </div>
                          );
                        }
                        return null;
                      }}
                    />
                    <Bar
                      dataKey="cents"
                      fill="#6366f1"
                      radius={[4, 4, 0, 0]}
                      cursor="pointer"
                    />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="text-center text-slate-500 text-sm">
                  No monthly trend data yet.
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Drill-Down Transaction Table Section */}
        <div className="bg-slate-800/60 border border-slate-700/60 rounded-xl overflow-hidden shadow-sm">
          {/* Table Header & Search Filter Bar */}
          <div className="p-5 border-b border-slate-700 flex flex-wrap items-center justify-between gap-4">
            <div className="flex flex-wrap items-center gap-3">
              <h3 className="font-semibold text-white">Transactions</h3>
              
              {/* Active Filter Chips */}
              {selectedCategory && (
                <span className="inline-flex items-center gap-1 text-xs bg-indigo-900/60 border border-indigo-700 text-indigo-200 px-2.5 py-1 rounded-full">
                  Category: {selectedCategory.name}
                  <button onClick={() => setSelectedCategory(null)} className="hover:text-white cursor-pointer">
                    <X className="w-3 h-3" />
                  </button>
                </span>
              )}
              {selectedMonth && (
                <span className="inline-flex items-center gap-1 text-xs bg-purple-900/60 border border-purple-700 text-purple-200 px-2.5 py-1 rounded-full">
                  Month: {selectedMonth}
                  <button onClick={() => setSelectedMonth(null)} className="hover:text-white cursor-pointer">
                    <X className="w-3 h-3" />
                  </button>
                </span>
              )}
            </div>

            <div className="flex items-center gap-4">
              <div className="relative">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
                <input
                  type="text"
                  placeholder="Search merchant..."
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  className="bg-slate-900 border border-slate-700 rounded-lg pl-9 pr-3 py-1.5 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-indigo-500 w-48"
                />
                {searchQuery && (
                  <button onClick={() => setSearchQuery('')} className="absolute right-2.5 top-2.5 text-slate-400 hover:text-white">
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>

              <div className="text-xs text-slate-400 font-mono">
                {txnCount} txns • <span className="text-white font-semibold">{formatCents(txnSumCents)}</span>
              </div>
            </div>
          </div>

          {/* Table Content */}
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs text-slate-300">
              <thead className="bg-slate-900/60 text-slate-400 uppercase tracking-wider font-semibold border-b border-slate-700/80">
                <tr>
                  <th className="px-5 py-3">Date</th>
                  <th className="px-5 py-3">Merchant / Description</th>
                  <th className="px-5 py-3">Account</th>
                  <th className="px-5 py-3">Category</th>
                  <th className="px-5 py-3 text-right">Amount</th>
                  <th className="px-5 py-3 text-center">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/50">
                {transactions.length > 0 ? (
                  transactions.map(txn => (
                    <tr key={txn.id} className="hover:bg-slate-700/30 transition">
                      <td className="px-5 py-3.5 whitespace-nowrap text-slate-400 font-mono">
                        {txn.date}
                      </td>
                      <td className="px-5 py-3.5">
                        <div className="font-medium text-white">{txn.merchant}</div>
                        <div className="text-[11px] text-slate-500 truncate max-w-xs">{txn.rawDescription}</div>
                      </td>
                      <td className="px-5 py-3.5 whitespace-nowrap text-slate-400">
                        {txn.bank} {txn.accountType}
                      </td>
                      <td className="px-5 py-3.5 whitespace-nowrap">
                        <span
                          className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium"
                          style={{
                            backgroundColor: `${txn.categoryColor}20`,
                            color: txn.categoryColor,
                            border: `1px solid ${txn.categoryColor}40`
                          }}
                        >
                          {txn.categoryName}
                        </span>
                        {txn.categorySource === 'manual' && (
                          <span className="ml-1 text-[10px] text-slate-500 font-mono">(manual)</span>
                        )}
                      </td>
                      <td className="px-5 py-3.5 whitespace-nowrap text-right font-mono font-medium">
                        {txn.kind === 'refund' ? (
                          <span className="text-emerald-400">-{formatCents(Math.abs(txn.amountCents))}</span>
                        ) : (
                          <span className="text-slate-100">{formatCents(txn.amountCents)}</span>
                        )}
                      </td>
                      <td className="px-5 py-3.5 whitespace-nowrap text-center">
                        <button
                          onClick={() => {
                            setEditingTxn(txn);
                            setNewCatId(txn.categoryId);
                          }}
                          className="text-xs text-indigo-400 hover:text-indigo-300 font-medium cursor-pointer"
                        >
                          Edit
                        </button>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={6} className="px-5 py-12 text-center text-slate-500">
                      No matching transactions found.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </main>

      {/* Recategorize Dialog Modal */}
      {editingTxn && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <div className="bg-slate-800 border border-slate-700 rounded-xl max-w-md w-full p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-slate-700 pb-3">
              <h3 className="font-semibold text-white">Reclassify Transaction</h3>
              <button onClick={() => setEditingTxn(null)} className="text-slate-400 hover:text-white cursor-pointer">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div>
              <p className="text-xs text-slate-400">Merchant</p>
              <p className="text-sm font-semibold text-white mt-0.5">{editingTxn.merchant}</p>
              <p className="text-xs text-slate-500 mt-0.5">{editingTxn.rawDescription}</p>
            </div>

            <div>
              <label className="text-xs text-slate-400 block mb-1.5">Select Category</label>
              <select
                value={newCatId}
                onChange={e => setNewCatId(parseInt(e.target.value))}
                className="w-full bg-slate-900 border border-slate-700 text-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
              >
                {categories.map(cat => (
                  <option key={cat.id} value={cat.id}>
                    {cat.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-center gap-2 pt-2">
              <input
                type="checkbox"
                id="rememberCheckbox"
                checked={rememberRule}
                onChange={e => setRememberRule(e.target.checked)}
                className="w-4 h-4 text-indigo-600 rounded bg-slate-900 border-slate-700 focus:ring-indigo-500 cursor-pointer"
              />
              <label htmlFor="rememberCheckbox" className="text-xs text-slate-300 cursor-pointer">
                Always categorize <span className="font-semibold text-white">"{editingTxn.merchant}"</span> as this category
              </label>
            </div>

            <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-700">
              <button
                onClick={() => setEditingTxn(null)}
                className="px-4 py-2 rounded-lg text-xs font-medium text-slate-300 hover:bg-slate-700 cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveCategoryChange}
                className="px-4 py-2 rounded-lg text-xs font-medium bg-indigo-600 hover:bg-indigo-500 text-white cursor-pointer flex items-center gap-1.5"
              >
                <Check className="w-3.5 h-3.5" /> Save Changes
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
