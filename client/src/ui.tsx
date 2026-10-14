import type { ReactNode, ButtonHTMLAttributes } from 'react';
import { X } from 'lucide-react';
import clsx from 'clsx';

export function Card({ title, subtitle, actions, children, className }: {
  title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string;
}) {
  return (
    <section className={clsx('bg-surface rounded-card p-5 shadow-card', className)}>
      {(title || actions) && (
        <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
          <div>
            {title && <h2 className="text-[15px] font-semibold tracking-tight text-ink">{title}</h2>}
            {subtitle && <p className="text-xs text-muted mt-0.5">{subtitle}</p>}
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
        'inline-flex items-center justify-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-medium transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed',
        variant === 'primary' && 'bg-accent hover:bg-accent-hover text-white shadow-soft',
        variant === 'secondary' && 'bg-surface hover:bg-page text-accent border border-accent/40',
        variant === 'danger' && 'bg-surface hover:bg-bad/5 text-bad border border-bad/40',
        variant === 'ghost' && 'text-ink-2 hover:bg-fill',
        className
      )}
    />
  );
}

/** iOS-style segmented control (same look as SparkFlow's header tabs) */
export function Segmented<T extends string>({ options, value, onChange, className }: {
  options: readonly { id: T; label: ReactNode }[]; value: T; onChange: (id: T) => void; className?: string;
}) {
  return (
    <div className={clsx('inline-flex gap-px bg-black/[0.06] p-0.5 rounded-[9px]', className)}>
      {options.map(o => (
        <button key={o.id} onClick={() => onChange(o.id)}
          className={clsx('px-3.5 py-1 rounded-[7px] text-xs cursor-pointer transition flex items-center gap-1.5',
            value === o.id ? 'bg-surface text-ink font-semibold shadow-soft' : 'text-ink-2 font-medium hover:text-ink')}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Modal({ title, onClose, children, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50 p-4" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className={clsx('bg-surface rounded-card w-full p-6 shadow-pop max-h-[90vh] overflow-y-auto', wide ? 'max-w-3xl' : 'max-w-md')}>
        <div className="flex items-center justify-between border-b border-line pb-3 mb-4">
          <h3 className="font-semibold text-ink">{title}</h3>
          <button onClick={onClose} className="text-muted hover:text-ink cursor-pointer" aria-label="Close">
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
    <span className="inline-flex items-center gap-1.5 text-xs bg-accent/10 text-brand px-2.5 py-1 rounded-full font-medium">
      {color && <span className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />}
      {children}
      {onClear && (
        <button onClick={onClear} className="hover:text-ink cursor-pointer" aria-label="Clear filter">
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
  'bg-page border border-line rounded-[10px] px-2.5 py-1.5 text-xs text-ink placeholder-muted focus:outline-none focus:border-accent focus:ring-3 focus:ring-accent/15';

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'good' | 'warn' | 'bad' }) {
  return (
    <div className="bg-surface rounded-card p-5 shadow-card">
      <div className="text-xs font-medium text-muted">{label}</div>
      <div className={clsx('mt-1 text-[26px] leading-tight font-extrabold tracking-tight', tone === 'good' ? 'text-good' : tone === 'warn' ? 'text-warn' : tone === 'bad' ? 'text-bad' : 'text-ink')}>
        {value}
      </div>
      {hint && <div className="mt-1 text-xs text-muted">{hint}</div>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="text-center text-muted text-sm py-10">{children}</div>;
}

/** Floating chart tooltip surface */
export const tooltipClass = 'bg-surface/95 backdrop-blur border border-line px-3 py-2 rounded-[10px] shadow-pop text-xs';
