/** Minimal interactive prompts (no dependency). Falls back to defaults when stdin is not a TTY. */
import { createInterface } from 'node:readline';
import pc from 'picocolors';

export const interactive = (): boolean => Boolean(process.stdin.isTTY && process.stdout.isTTY);

export async function ask(question: string, def = ''): Promise<string> {
  if (!interactive()) return def;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const suffix = def ? pc.dim(` (${def})`) : '';
  return new Promise((res) => {
    rl.question(`${question}${suffix}: `, (answer) => {
      rl.close();
      res(answer.trim() || def);
    });
  });
}

export async function confirm(question: string, def = false): Promise<boolean> {
  if (!interactive()) return def;
  const a = (await ask(`${question} ${pc.dim(def ? '[Y/n]' : '[y/N]')}`, '')).toLowerCase();
  if (!a) return def;
  return a === 'y' || a === 'yes';
}

/** Ask for a secret without echoing it. */
export async function askSecret(question: string): Promise<string> {
  if (!interactive()) return '';
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const out = rl as unknown as { _writeToOutput?: (s: string) => void; output: NodeJS.WriteStream };
  let muted = false;
  out._writeToOutput = (s: string) => {
    if (!muted) process.stdout.write(s);
  };
  return new Promise((res) => {
    rl.question(`${question}: `, (answer) => {
      rl.close();
      process.stdout.write('\n');
      res(answer.trim());
    });
    muted = true;
  });
}
