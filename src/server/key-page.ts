/**
 * A one-off page on this computer where the user types API keys, for clients (Claude, Cursor,
 * VS Code) that talk to `avc mcp`. Keys typed here go from the browser straight to this
 * process and into the OS secret store: they never pass through the MCP client, the chat or
 * the AI model, which only ever see the link.
 *
 * The page is write-only (it shows whether a key is set, never its value), listens on
 * 127.0.0.1 on a random port, needs the random token in its path, accepts a POST only from
 * its own origin, and shuts down after a save or after 15 minutes. Knowing the link lets
 * someone save keys, never read them.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { saveSecrets } from '../core/config.js';
import {
  SECRET_FIELDS,
  secretSource,
  secretStore,
  type SecretField,
  type SecretGroup,
} from '../core/secrets.js';

export type KeyPageOutcome = 'saved' | 'skipped' | 'expired' | 'closed';

export interface KeyPage {
  url: string;
  /** Resolves when the user saves, skips, or the page expires. */
  done: Promise<KeyPageOutcome>;
  close(): void;
}

export interface KeyPageOptions {
  /** Which keys to offer. Default: the AI keys, with data-source keys folded away. */
  groups?: SecretGroup[];
  /** Why the keys are being asked for, shown at the top. */
  reason?: string;
  ttlMs?: number;
  /** Called with the ids saved (never the values). */
  onSaved?(ids: string[]): void;
}

const MAX_BODY = 64 * 1024;

function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!,
  );
}

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const CSS = `
:root{color-scheme:light dark;--bg:#fff;--fg:#1a1a1a;--muted:#666;--line:#ddd;--accent:#2457d6;--ok:#1b7f3b}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#eee;--muted:#9a9a9a;--line:#333;--accent:#7aa2ff;--ok:#5fd28a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:640px;margin:0 auto;padding:32px 16px 48px}h1{font-size:22px;margin:0 0 8px}
p{margin:0 0 12px}.muted{color:var(--muted);font-size:13px}.box{border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin:16px 0}
label{display:block;font-weight:600;margin:14px 0 4px}small{font-weight:400;color:var(--muted)}
input{width:100%;padding:9px 10px;border:1px solid var(--line);border-radius:6px;background:transparent;color:inherit;font:inherit}
.set{color:var(--ok);font-weight:600}.row{display:flex;gap:10px;flex-wrap:wrap;margin-top:22px}
button{padding:9px 16px;border-radius:6px;border:1px solid var(--line);background:transparent;color:inherit;font:inherit;cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}details{margin-top:18px}summary{cursor:pointer;font-weight:600}
`;

function fieldHtml(f: SecretField): string {
  const set = secretSource(f) !== 'none';
  return `<label for="${esc(f.id)}">${esc(f.label)} ${
    set ? '<span class="set">set</span> <small>(type a new key to replace it)</small>' : ''
  }<br><small>${esc(f.unlocks)}${
    f.getAt ? ` Get one at ${esc(f.getAt)}` : ''
  }</small></label><input id="${esc(f.id)}" name="${esc(f.id)}" type="password" autocomplete="off" spellcheck="false">`;
}

function page(body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Add API keys</title><style>${CSS}</style></head><body><main>${body}</main></body></html>`;
}

function formPage(action: string, groups: SecretGroup[], reason?: string): string {
  const where = secretStore().where;
  const ai = SECRET_FIELDS.filter((f) => f.group === 'ai' && groups.includes('ai'));
  const rest = SECRET_FIELDS.filter((f) => f.group !== 'ai' && groups.includes(f.group));
  return page(`
<h1>Add API keys for AI Visibility Checker</h1>
${reason ? `<p>${esc(reason)}</p>` : ''}
<div class="box"><p><strong>Your keys stay on this computer.</strong> They are saved in ${esc(where)} and sent only to the provider each key belongs to. They are not shown to Claude or any other AI assistant, not sent to Devs Core, and this page never displays them again.</p>
<p class="muted">Leave a field empty to skip it. Anything that needs a skipped key is skipped and reported, and the rest still runs.</p></div>
<form method="post" action="${esc(action)}">
${ai.length ? '<p class="muted">One Vercel AI Gateway key covers every engine. Or add a key per provider for the engines you want.</p>' : ''}
${ai.map(fieldHtml).join('\n')}
${rest.length ? `<details><summary>Optional data sources</summary>${rest.map(fieldHtml).join('\n')}</details>` : ''}
<div class="row"><button class="primary" type="submit" name="action" value="save">Save keys</button>
<button type="submit" name="action" value="skip">Skip for now</button></div>
</form>`);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error('Request too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Start the page. The caller shows `url` to the user (or asks the MCP client to open it). */
export async function startKeyPage(opts: KeyPageOptions = {}): Promise<KeyPage> {
  const token = randomBytes(24).toString('base64url');
  const path = `/keys/${token}`;
  const groups = opts.groups ?? ['ai', 'data'];
  let finish!: (o: KeyPageOutcome) => void;
  const done = new Promise<KeyPageOutcome>((res) => (finish = res));
  let origin = '';
  let settled = false;

  const send = (res: ServerResponse, status: number, html: string) => {
    res.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy':
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    });
    res.end(html);
  };

  const server = createServer(async (req, res) => {
    try {
      // DNS rebinding: only our own loopback address and port.
      if ((req.headers.host ?? '').toLowerCase() !== origin.replace('http://', ''))
        return send(res, 403, page('<p>Forbidden.</p>'));
      const url = new URL(req.url ?? '/', origin);
      if (settled || !url.pathname.startsWith('/keys/') || !sameToken(url.pathname, path))
        return send(res, 404, page('<p>This link has expired. Ask for a new one.</p>'));
      if (req.method === 'GET') return send(res, 200, formPage(path, groups, opts.reason));
      if (req.method !== 'POST') return send(res, 405, page('<p>Method not allowed.</p>'));
      // Only a form submitted from this page (CSRF).
      // `Origin: null` (a hidden referrer) falls back to the browser-set Sec-Fetch-Site.
      const from = req.headers.origin;
      const fetchSite = req.headers['sec-fetch-site'];
      if (from === 'null' ? fetchSite !== 'same-origin' : from && from !== origin)
        return send(res, 403, page('<p>Forbidden.</p>'));
      if (!from && fetchSite && fetchSite !== 'same-origin')
        return send(res, 403, page('<p>Forbidden.</p>'));
      const form = new URLSearchParams(await readBody(req));
      if (form.get('action') === 'skip') {
        settled = true;
        send(
          res,
          200,
          page(
            '<h1>Skipped</h1><p>No keys were saved. Steps that need a key are skipped and listed in the results. You can close this tab.</p>',
          ),
        );
        finish('skipped');
        return;
      }
      const values: Record<string, string> = {};
      for (const f of SECRET_FIELDS) {
        if (!groups.includes(f.group)) continue;
        const v = (form.get(f.id) ?? '').trim();
        if (v) values[f.id] = v;
      }
      if (!Object.keys(values).length)
        return send(
          res,
          200,
          formPage(path, groups, 'Nothing was typed. Add a key, or choose Skip.'),
        );
      saveSecrets(values);
      settled = true;
      const labels = SECRET_FIELDS.filter((f) => values[f.id]).map((f) => f.label);
      send(
        res,
        200,
        page(
          `<h1>Saved</h1><p>Saved ${labels.map(esc).join(', ')} in ${esc(secretStore().where)}.</p><p>You can close this tab and go back to your assistant.</p>`,
        ),
      );
      opts.onSaved?.(Object.keys(values));
      finish('saved');
    } catch {
      send(res, 500, page('<p>Something went wrong. Nothing was shown or logged.</p>'));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const timer = setTimeout(() => finish('expired'), opts.ttlMs ?? 15 * 60_000);
  timer.unref();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    finish('closed');
    server.close();
    server.closeAllConnections?.();
  };
  // Let the browser receive the final page before the server goes away.
  void done.then(() => setTimeout(close, 1000).unref());
  server.unref();

  return { url: `${origin}${path}`, done, close };
}
