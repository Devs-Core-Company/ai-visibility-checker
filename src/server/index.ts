/** `avc ui`: start the local dashboard on 127.0.0.1 with a one-time session token. */
import { randomBytes } from 'node:crypto';
import { serve } from '@hono/node-server';
import pc from 'picocolors';
import { createApp } from './app.js';
import { JobManager } from './jobs.js';
import { getConfig, getStore } from '../cli/services.js';
import { openPath } from '../cli/open.js';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export interface DashboardOptions {
  port?: number;
  host?: string;
  open?: boolean;
  monitor?: boolean;
}

export function isLoopback(host: string): boolean {
  return LOOPBACK.has(host.toLowerCase());
}

export async function startDashboard(
  opts: DashboardOptions = {},
): Promise<{ url: string; close: () => void }> {
  const config = getConfig();
  const host = opts.host ?? config.server.host ?? '127.0.0.1';
  const port = opts.port ?? config.server.port ?? 4317;
  if (!isLoopback(host)) {
    console.error(
      pc.yellow(
        `! Listening on ${host}: other machines on your network can reach this dashboard. It still needs the session token, but only do this on a network you trust (for example inside Docker with the port bound to 127.0.0.1 on the host).`,
      ),
    );
  }
  const token = process.env.AVC_UI_TOKEN || randomBytes(24).toString('base64url');
  const extraHosts = isLoopback(host)
    ? []
    : [host, ...(process.env.AVC_UI_HOSTS ?? '').split(',').filter(Boolean)];
  const jobs = new JobManager();
  const app = createApp({ token, port, extraHosts, jobs });

  const server = serve({
    fetch: app.fetch,
    port,
    hostname: host === 'localhost' ? '127.0.0.1' : host,
  });
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', (err: NodeJS.ErrnoException) =>
      reject(
        err.code === 'EADDRINUSE'
          ? new Error(`Port ${port} is in use. Try \`avc ui --port ${port + 1}\`.`)
          : err,
      ),
    );
  });

  const shownHost = isLoopback(host) || host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const url = `http://${shownHost}:${port}/?token=${token}`;
  console.log(pc.bold('AI Visibility Checker dashboard'));
  console.log(`  ${pc.cyan(url)}`);
  console.log(
    pc.dim('  The link carries a one-time session token. Keep this terminal open; Ctrl+C to stop.'),
  );

  let stopScheduler: (() => void) | null = null;
  if (opts.monitor) {
    const { startScheduler } = await import('../monitor/scheduler.js');
    const { describeRun } = await import('../cli/commands/monitor.js');
    const handle = startScheduler(config, {
      store: getStore(config),
      onRun: (r) => console.log(describeRun(r)),
    });
    stopScheduler = () => handle.stop();
    console.log(pc.dim(`  Monitoring ${handle.jobs.length} schedule(s).`));
  }
  if (opts.open !== false && isLoopback(host) && !process.env.CI) openPath(url);

  const close = () => {
    stopScheduler?.();
    server.close();
  };
  const onSignal = () => {
    close();
    process.exit(0);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  return { url, close };
}
