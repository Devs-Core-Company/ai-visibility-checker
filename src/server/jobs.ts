/** Background jobs (audits, visibility runs) with progress events the dashboard streams over SSE. */
import { randomBytes } from 'node:crypto';
import type { ProgressEvent, ProgressFn } from '../core/types.js';

export interface Job {
  id: string;
  kind: 'audit' | 'visibility';
  siteId: string;
  label: string;
  startedAt: string;
  status: 'running' | 'done' | 'error' | 'cancelled';
  events: ProgressEvent[];
  /** Where to go when it finishes. */
  redirect?: string;
  error?: string;
  controller: AbortController;
  listeners: Set<(e: JobMessage) => void>;
}

export type JobMessage =
  | { event: 'progress'; data: ProgressEvent }
  | { event: 'done'; data: { redirect?: string; error?: string } };

const MAX_EVENTS = 2000;

export class JobManager {
  private jobs = new Map<string, Job>();

  list(): Job[] {
    return [...this.jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  running(siteId: string): Job | undefined {
    return this.list().find((j) => j.siteId === siteId && j.status === 'running');
  }

  start(
    kind: Job['kind'],
    siteId: string,
    label: string,
    work: (onProgress: ProgressFn, signal: AbortSignal) => Promise<string | undefined>,
  ): Job {
    const job: Job = {
      id: randomBytes(6).toString('hex'),
      kind,
      siteId,
      label,
      startedAt: new Date().toISOString(),
      status: 'running',
      events: [],
      controller: new AbortController(),
      listeners: new Set(),
    };
    this.jobs.set(job.id, job);
    const emit = (m: JobMessage) => {
      for (const l of job.listeners) {
        try {
          l(m);
        } catch {
          /* listener gone */
        }
      }
    };
    const onProgress: ProgressFn = (e) => {
      job.events.push(e);
      if (job.events.length > MAX_EVENTS) job.events.splice(0, job.events.length - MAX_EVENTS);
      emit({ event: 'progress', data: e });
    };
    work(onProgress, job.controller.signal).then(
      (redirect) => {
        job.status = 'done';
        job.redirect = redirect;
        emit({ event: 'done', data: { redirect } });
      },
      (err: unknown) => {
        job.status = job.controller.signal.aborted ? 'cancelled' : 'error';
        job.error =
          job.status === 'cancelled'
            ? 'Cancelled.'
            : err instanceof Error
              ? err.message
              : String(err);
        emit({ event: 'done', data: { error: job.error } });
      },
    );
    // Keep the last 50 jobs.
    const all = this.list();
    for (const old of all.slice(50)) if (old.status !== 'running') this.jobs.delete(old.id);
    return job;
  }

  cancel(id: string): boolean {
    const j = this.jobs.get(id);
    if (!j || j.status !== 'running') return false;
    j.controller.abort();
    return true;
  }
}
