import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Per-user app settings, kept outside the project folder (and outside git):
 *   ~/.walletwhisper/config.json  { dataFolder, aiKey }
 * dataFolder is chosen by the user on first run; aiKey is optional.
 */
export interface AppConfig {
  dataFolder?: string;
  aiKey?: string;
}

export function configFile(): string {
  return process.env.WALLETWHISPER_CONFIG || path.join(os.homedir(), '.walletwhisper', 'config.json');
}

export function readConfig(): AppConfig {
  try {
    return JSON.parse(fs.readFileSync(configFile(), 'utf-8')) as AppConfig;
  } catch {
    return {};
  }
}

export function updateConfig(patch: Partial<AppConfig>): AppConfig {
  const next = { ...readConfig(), ...patch };
  for (const k of Object.keys(next) as (keyof AppConfig)[]) if (!next[k]) delete next[k];
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  // Owner-only permissions: the file may hold an API key
  fs.writeFileSync(configFile(), JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

/** Earlier versions kept data in <project>/data; keep using it if it's there. */
function legacyDataFolder(): string | null {
  const dir = process.env.WALLETWHISPER_LEGACY_DIR || path.resolve(process.cwd(), 'data');
  return fs.existsSync(path.join(dir, 'app.db')) ? dir : null;
}

/** The folder holding app.db and backups/, or null until the user has chosen one. */
export function dataFolder(): string | null {
  const cfg = readConfig();
  if (cfg.dataFolder) return cfg.dataFolder;
  const legacy = legacyDataFolder();
  if (legacy) {
    updateConfig({ dataFolder: legacy });
    return legacy;
  }
  return null;
}

export function suggestedDataFolder(): string {
  const docs = path.join(os.homedir(), 'Documents');
  return path.join(fs.existsSync(docs) ? docs : os.homedir(), 'WalletWhisper');
}
