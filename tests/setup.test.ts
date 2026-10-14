import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createServer } from '../src/server.js';
import { resetDbInstance } from '../src/db.js';
import { readConfig } from '../src/config.js';
import { detectProvider } from '../src/llm.js';

// Runs the app as a brand-new user would: no database yet, config and data in a temp folder.
// vitest.config.ts already points the settings file and legacy data lookup at temp paths.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'walletwhisper-setup-'));
const FAKE_CLAUDE_KEY = 'sk-ant-' + 'x'.repeat(40);

describe('first run and settings', () => {
  let app: any;
  let token: string;
  const savedDbPath = process.env.SPENDING_DB_PATH;
  const post = (url: string) => request(app).post(url).set('X-App-Token', token);
  const put = (url: string) => request(app).put(url).set('X-App-Token', token);

  beforeAll(async () => {
    delete process.env.SPENDING_DB_PATH;
    resetDbInstance();
    app = await createServer();
    token = (await request(app).get('/api/session')).body.token;
  });

  afterAll(() => {
    resetDbInstance();
    process.env.SPENDING_DB_PATH = savedDbPath;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('F-01: asks a new user where to keep their data before anything else works', async () => {
    const setup = await request(app).get('/api/setup');
    expect(setup.body.configured).toBe(false);
    expect(path.isAbsolute(setup.body.suggestedFolder)).toBe(true);
    expect((await request(app).get('/api/summary')).status).toBe(409);
  });

  it('F-02: rejects a relative folder, then sets up in the chosen folder', async () => {
    expect((await post('/api/setup').send({ folder: 'my-data' })).status).toBe(400);
    const folder = path.join(root, 'chosen');
    const res = await post('/api/setup').send({ folder });
    expect(res.status).toBe(200);
    expect(fs.existsSync(path.join(folder, 'app.db'))).toBe(true);
    expect(readConfig().dataFolder).toBe(folder);
    expect((await request(app).get('/api/summary')).status).toBe(200);
    expect((await post('/api/setup').send({ folder })).status).toBe(400); // only once
  });

  it('F-03: moves the data to a new folder and keeps the old copy', async () => {
    const before = (await request(app).get('/api/settings')).body.dataFolder;
    await post('/api/people').send({ name: 'Test Person' });
    const folder = path.join(root, 'moved');
    const res = await post('/api/settings/data-folder').send({ folder });
    expect(res.status).toBe(200);
    expect(fs.existsSync(path.join(folder, 'app.db'))).toBe(true);
    expect(fs.existsSync(path.join(before, 'app.db'))).toBe(true);
    expect((await request(app).get('/api/settings')).body.dataFolder).toBe(folder);
    expect((await request(app).get('/api/people')).body.people.map((p: any) => p.name)).toContain('Test Person');
  });

  it('F-04: saves an AI key to the settings file, never echoes it back, and can remove it', async () => {
    expect((await put('/api/settings/ai').send({ key: 'not-a-key' })).status).toBe(400);
    const saved = await put('/api/settings/ai').send({ key: FAKE_CLAUDE_KEY });
    expect(saved.body.aiProvider).toBe('Claude');
    const settings = await request(app).get('/api/settings');
    expect(settings.body.aiProvider).toBe('Claude');
    expect(JSON.stringify(settings.body)).not.toContain(FAKE_CLAUDE_KEY);
    expect(readConfig().aiKey).toBe(FAKE_CLAUDE_KEY);
    await put('/api/settings/ai').send({ key: '' });
    expect(readConfig().aiKey).toBeUndefined();
  });

  it('F-05: recognises Claude, Gemini and OpenAI keys by their format', () => {
    expect(detectProvider(FAKE_CLAUDE_KEY)).toBe('claude');
    expect(detectProvider('AIza' + 'y'.repeat(35))).toBe('gemini');
    expect(detectProvider('sk-proj-' + 'z'.repeat(40))).toBe('openai');
    expect(detectProvider('hello')).toBeNull();
  });
});
