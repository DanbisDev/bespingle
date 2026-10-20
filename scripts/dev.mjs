import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const cache = join(root, '.cache');
await mkdir(cache, { recursive: true });
const children = [];
let shuttingDown = false;

function stop(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    try {
      if (process.platform === 'win32') child.kill('SIGTERM');
      else process.kill(-child.pid, 'SIGTERM');
    } catch { /* The child may already have exited. */ }
  }
  setTimeout(() => process.exit(code), 400).unref();
}

function start(command, args, extraEnv = {}) {
  const child = spawn(command, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
    // Include the compiled `go run` child when shutting the dev stack down.
    detached: process.platform !== 'win32',
  });
  children.push(child);
  child.on('error', (error) => { console.error(error.message); stop(1); });
  child.on('exit', (code, signal) => { if (!shuttingDown) stop(signal ? 1 : (code ?? 1)); });
}

start('go', ['run', './server'], { GOCACHE: join(cache, 'go-build'), GOMODCACHE: join(cache, 'go-mod') });
start(process.execPath, ['node_modules/vite/bin/vite.js']);
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
