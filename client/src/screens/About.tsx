import type { ReactNode } from 'react';
import { BarChart3, FileSpreadsheet, HardDrive, Layers, Lock, ShieldCheck, Sparkles, Users } from 'lucide-react';
import { useRoute } from '../lib';

const STEPS = [
  { color: '#005594', label: 'Download CSVs from your bank', desc: 'Export statements from each bank website, the same way you always do.' },
  { color: '#4398D3', label: 'Drop them into WalletWhisper', desc: 'Files are read by the program running on this computer. Nothing is uploaded to a server.' },
  { color: '#EE8D3D', label: 'Answer a few questions', desc: 'Tell it which payments move money between your own accounts, so every dollar is counted once.' },
  { color: '#C5362F', label: 'See where the money goes', desc: 'Monthly overview, trends, and who spent what, by person and by account.' },
];

export function About() {
  return (
    <div className="max-w-5xl mx-auto">
      <div className="text-center mb-10">
        <h2 className="text-4xl font-extrabold tracking-[-0.8px] text-ink mb-3">Your money, quietly explained.</h2>
        <p className="text-[17px] text-ink-2 max-w-xl mx-auto leading-relaxed">
          WalletWhisper turns bank statements from all your accounts into one clear picture of your household's spending,
          without your financial data ever leaving this computer.
        </p>
      </div>

      <PrivacyPanel />

      <div className="grid grid-cols-1 lg:grid-cols-[340px_1fr] gap-8 items-stretch mt-10">
        <div className="flex flex-col">
          <SectionTitle>How it works</SectionTitle>
          <ol className="relative pl-7 before:absolute before:left-[7px] before:top-2 before:bottom-2 before:w-0.5 before:bg-black/10 before:rounded">
            {STEPS.map(s => (
              <li key={s.label} className="relative pb-6 last:pb-0">
                <span className="absolute -left-7 top-0.5 w-4 h-4 rounded-full border-[3px] border-page shadow-[0_0_0_2px_rgba(0,0,0,0.06)]"
                  style={{ backgroundColor: s.color }} />
                <div className="text-[15px] font-semibold text-ink mb-1">{s.label}</div>
                <div className="text-[13px] text-muted leading-normal">{s.desc}</div>
              </li>
            ))}
          </ol>
        </div>

        <div className="flex flex-col">
          <SectionTitle>Features</SectionTitle>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 flex-1">
            <Feature color="#005594" icon={<FileSpreadsheet />} title="Many banks, one view" desc="Import CSV statements from checking and credit card accounts at different banks" />
            <Feature color="#4398D3" icon={<Layers />} title="Every dollar once" desc="Card payments and transfers between your accounts are matched, so nothing is double counted" />
            <Feature color="#EE8D3D" icon={<BarChart3 />} title="See it visually" desc="Monthly overview, category donut, and trends that flag incomplete months" />
            <Feature color="#5856D6" icon={<Users />} title="Who spent what" desc="Mark each transaction with a person; set a default person per account" />
            <Feature color="#34C759" icon={<Sparkles />} title="Optional AI categories" desc="Off unless you add your own AI key in Settings, and used only when you press the button" />
            <Feature color="#C5362F" icon={<Lock />} title="100% private" desc="No accounts, no cloud, no tracking. Your data stays in a folder on this computer" />
          </div>
        </div>
      </div>

      <div className="mt-10 bg-surface rounded-card shadow-card p-7 text-center">
        <div className="text-[11px] font-semibold text-muted uppercase tracking-[0.6px] mb-2">Open source</div>
        <div className="text-[22px] font-bold tracking-tight">
          <a className="text-accent hover:underline" href="https://github.com/XiaoLiu8811/financialTool" target="_blank" rel="noopener noreferrer">
            Read every line on GitHub
          </a>
        </div>
        <p className="text-sm text-muted mt-1">
          The code is public so anyone can check these privacy promises. Your data is never part of it.
        </p>
      </div>
    </div>
  );
}

function PrivacyPanel() {
  const { navigate } = useRoute();
  return (
    <section className="bg-surface rounded-card shadow-card p-6 sm:p-7">
      <div className="flex items-start gap-4">
        <div className="w-11 h-11 min-w-11 rounded-full bg-good/10 text-good flex items-center justify-center">
          <ShieldCheck className="w-6 h-6" />
        </div>
        <div className="flex-1">
          <h3 className="text-lg font-bold tracking-tight text-ink">Your data stays on this computer</h3>
          <p className="text-sm text-ink-2 mt-1 leading-relaxed">
            WalletWhisper is a program that runs on your own computer. There is no WalletWhisper server, no sign-up and no tracking.
          </p>

          <ul className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3 text-sm">
            <Fact icon={<HardDrive />} title="Saved in a folder you chose">
              Your transactions, people and choices, plus automatic backups, are kept in your data folder.
              See or change it in{' '}
              <button className="text-accent hover:underline cursor-pointer" onClick={() => navigate('settings')}>Settings</button>.
            </Fact>
            <Fact icon={<Lock />} title="Only you can open it">
              The app only accepts connections from this computer, so other devices and websites can't read your data.
            </Fact>
            <Fact icon={<ShieldCheck />} title="Nothing is uploaded">
              Bank files are read on this computer. Downloading WalletWhisper from GitHub gives you only the program, never anyone's data.
            </Fact>
            <Fact icon={<Sparkles />} title="AI is optional">
              It's off unless you add your own AI key. Even then, nothing is sent until you press <b>AI categorize</b>,
              and never account numbers, balances, dates or names.
            </Fact>
          </ul>
        </div>
      </div>
    </section>
  );
}

function Fact({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="text-accent mt-0.5 [&>svg]:w-4 [&>svg]:h-4">{icon}</span>
      <span>
        <span className="block font-semibold text-ink">{title}</span>
        <span className="text-muted leading-normal">{children}</span>
      </span>
    </li>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <h3 className="text-[13px] font-semibold text-muted uppercase tracking-[0.6px] mb-4">{children}</h3>;
}

function Feature({ color, icon, title, desc }: { color: string; icon: ReactNode; title: string; desc: string }) {
  return (
    <div className="bg-surface rounded-[10px] p-4 shadow-soft flex gap-3 items-start">
      <div className="w-9 h-9 min-w-9 rounded-[10px] flex items-center justify-center [&>svg]:w-[18px] [&>svg]:h-[18px]"
        style={{ backgroundColor: `${color}1a`, color }}>
        {icon}
      </div>
      <div>
        <span className="block text-sm font-semibold text-ink mb-0.5">{title}</span>
        <span className="text-xs text-muted leading-snug">{desc}</span>
      </div>
    </div>
  );
}
