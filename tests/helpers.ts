import fs from 'fs';
import path from 'path';
import { ApiError, LocalApi, type Host, type UploadedFile } from '../src/app.js';

/** A host that keeps everything in memory, recording what the app asked it to save. */
export interface MemoryHost extends Host { saves: number; snapshots: string[]; key: string | null }

export function memoryHost(): MemoryHost {
  const host: MemoryHost = {
    saves: 0,
    snapshots: [] as string[],
    key: null as string | null,
    save() { host.saves++; },
    snapshot(label: string) { host.snapshots.push(label); },
    aiKey: () => host.key,
    setAiKey(k: string | null) { host.key = k; },
  };
  return host;
}

export const fixtureFile = (name: string): UploadedFile =>
  ({ name, bytes: new Uint8Array(fs.readFileSync(path.resolve(__dirname, 'fixtures', name))) });

/** Calls the app like the screens do, returning { status, body } instead of throwing. */
export function client(api: LocalApi) {
  const call = async (method: string, url: string, body?: Record<string, unknown>) => {
    try {
      return { status: 200, body: (await api.handle({ method, url, body })) as any };
    } catch (err) {
      if (err instanceof ApiError) return { status: err.status, body: { error: err.message } as any };
      throw err;
    }
  };
  return {
    get: (url: string) => call('GET', url),
    post: (url: string, body?: Record<string, unknown>) => call('POST', url, body),
    patch: (url: string, body?: Record<string, unknown>) => call('PATCH', url, body),
    put: (url: string, body?: Record<string, unknown>) => call('PUT', url, body),
    del: (url: string) => call('DELETE', url),
  };
}
