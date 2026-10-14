import { describe, it, expect } from 'vitest';
import { LocalApi } from '../src/app.js';
import { detectProvider } from '../src/llm.js';
import { client, memoryHost } from './helpers.js';

const FAKE_CLAUDE_KEY = 'sk-ant-' + 'x'.repeat(40);

describe('first run and settings', () => {
  const host = memoryHost();
  const app = new LocalApi(host, null);
  const api = client(app);

  it('F-01: a new user starts with no data, and nothing works until set up', async () => {
    expect((await api.get('/api/setup')).body.configured).toBe(false);
    expect((await api.get('/api/summary')).status).toBe(409);
    expect(host.saves).toBe(0);
  });

  it('F-02: setting up creates an empty database, saved straight away, only once', async () => {
    expect((await api.post('/api/setup')).status).toBe(200);
    expect(host.saves).toBeGreaterThan(0);
    expect((await api.get('/api/summary')).body.totalSpend).toBe(0);
    expect((await api.post('/api/setup')).status).toBe(400);
  });

  it('F-03: data saved by the browser opens again with everything in it', async () => {
    await api.post('/api/people', { name: 'Test Person' });
    const reopened = client(new LocalApi(memoryHost(), app.database!.export()));
    expect((await reopened.get('/api/people')).body.people.map((p: any) => p.name)).toContain('Test Person');
  });

  it('F-04: keeps the AI key with the host, never echoes it back, and can remove it', async () => {
    expect((await api.put('/api/settings/ai', { key: 'not-a-key' })).status).toBe(400);
    const saved = await api.put('/api/settings/ai', { key: FAKE_CLAUDE_KEY });
    expect(saved.body.aiProvider).toBe('Claude');
    const settings = await api.get('/api/settings');
    expect(settings.body).toEqual({ aiConfigured: true, aiProvider: 'Claude' });
    expect(host.key).toBe(FAKE_CLAUDE_KEY);
    await api.put('/api/settings/ai', { key: '' });
    expect(host.key).toBeNull();
  });

  it('F-05: recognises Claude, Gemini and OpenAI keys by their format', () => {
    expect(detectProvider(FAKE_CLAUDE_KEY)).toBe('claude');
    expect(detectProvider('AIza' + 'y'.repeat(35))).toBe('gemini');
    expect(detectProvider('sk-proj-' + 'z'.repeat(40))).toBe('openai');
    expect(detectProvider('hello')).toBeNull();
  });

  it('F-06: AI features say how to turn them on when there is no key', async () => {
    const res = await api.post('/api/ask', { question: 'What did we spend on dining last month?' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Settings/);
  });
});
