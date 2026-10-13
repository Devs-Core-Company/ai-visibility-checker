import { spawn } from 'node:child_process';

/** Open a file or URL with the system handler. Never throws. */
export function openPath(target: string): void {
  try {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '""', target] : [target];
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* no opener available: the path is printed anyway */
  }
}
