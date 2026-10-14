import type { ReactNode, ButtonHTMLAttributes } from 'react';
import { X } from 'lucide-react';
import clsx from 'clsx';

export function Card({ title, subtitle, actions, children, className }: {
  title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string;
}) {
  return (
    <section className={clsx('bg-slate-800/60 border border-slate-700/60 rounded-xl p-5 shadow-sm', className)}>
      {(title || actions) && (
        <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
          <div>
            {title && <h2 className="text-base font-semibold text-white">{title}</h2>}
            {subtitle && <p className="text-xs text-slate-400 mt-0.5">{subtitle}</p>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';
export function Button({ variant = 'secondary', className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      {...rest}
      className={clsx(
        'inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed',
        variant === 'primary' && 'bg-indigo-600 hover:bg-indigo-500 text-white',
        variant === 'secondary' && 'bg-slate-700 hover:bg-slate-600 text-slate-100 border border-slate-600',
        variant === 'danger' && 'bg-rose-700 hover:bg-rose-600 text-white',
        variant === 'ghost' && 'text-slate-300 hover:bg-slate-700/60',
        className
      )}
    />
  );
}

export function Modal({ title, onClose, children, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className={clsx('bg-slate-800 border border-slate-700 rounded-xl w-full p-6 shadow-2xl max-h-[90vh] overflow-y-auto', wide ? 'max-w-3xl' : 'max-w-md')}>
        <div className="flex items-center justify-between border-b border-slate-700 pb-3 mb-4">
          <h3 className="font-semibold text-white">{title}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-white cursor-pointer" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Chip({ children, onClear, color }: { children: ReactNode; onClear?: () => void; color?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs bg-indigo-900/50 border border-indigo-700 text-indigo-100 px-2.5 py-1 rounded-full">
      {color && <span className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />}
      {children}
      {onClear && (
        <button onClick={onClear} className="hover:text-white cursor-pointer" aria-label="Clear filter">
          <X className="w-3 h-3" />
        </button>
      )}
    </span>
  );
}

export function Dot({ color }: { color: string }) {
  return <span className="inline-block w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: color }} />;
}

export const inputClass =
  'bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-indigo-500';

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'good' | 'warn' | 'bad' }) {
  return (
    <div className="bg-slate-800/60 border border-slate-700/60 rounded-xl p-4">
      <div className="text-xs font-medium text-slate-400">{label}</div>
      <div className={clsx('mt-1.5 text-2xl font-bold', tone === 'good' ? 'text-emerald-400' : tone === 'warn' ? 'text-amber-300' : tone === 'bad' ? 'text-rose-300' : 'text-white')}>
        {value}
      </div>
      {hint && <div className="mt-1 text-xs text-slate-400">{hint}</div>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="text-center text-slate-500 text-sm py-10">{children}</div>;
}
