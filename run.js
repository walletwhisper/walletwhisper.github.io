import { createServer } from './src/server.ts';
import { currentDataFolder } from './src/db.ts';
import { exec } from 'child_process';

const PORT = 8000;

async function start() {
  const app = await createServer();
  app.listen(PORT, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${PORT}`;
    console.log(`\n======================================================`);
    console.log(` WalletWhisper is running at: ${url}`);
    const folder = currentDataFolder();
    console.log(folder
      ? ` Your data stays on this computer, in: ${folder}`
      : ` First run: choose where to keep your data in the browser window.`);
    console.log(`======================================================\n`);

    // Auto-open browser on Windows/macOS/Linux
    const startCmd = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    exec(`${startCmd} ${url}`);
  });
}

start().catch(err => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
