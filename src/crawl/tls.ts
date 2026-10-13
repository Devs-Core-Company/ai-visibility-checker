/**
 * The origin's TLS certificate: who issued it, when it expires and whether
 * browsers accept it. The crawler's fetcher must keep working on sites with a
 * broken certificate, so the certificate is read here with its own connection.
 */
import { connect, type PeerCertificate } from 'node:tls';
import type { TlsInfo } from '../core/types.js';

const DAY = 86_400_000;

export function summariseCert(
  host: string,
  cert: Partial<PeerCertificate> | null,
  authorized: boolean,
  error?: string,
  now = Date.now(),
): TlsInfo {
  const out: TlsInfo = { host, authorized };
  if (error) out.error = error;
  if (!cert || !cert.valid_to) return out;
  const to = Date.parse(cert.valid_to);
  const from = cert.valid_from ? Date.parse(cert.valid_from) : NaN;
  if (Number.isFinite(to)) {
    out.validTo = new Date(to).toISOString();
    out.daysLeft = Math.floor((to - now) / DAY);
  }
  if (Number.isFinite(from)) out.validFrom = new Date(from).toISOString();
  const name = (x: unknown) => {
    if (!x || typeof x !== 'object') return undefined;
    const o = x as Record<string, string | string[]>;
    const v = o.O ?? o.CN;
    return Array.isArray(v) ? v[0] : v;
  };
  out.issuer = name(cert.issuer);
  out.subject = name(cert.subject);
  if (cert.subjectaltname)
    out.altNames = cert.subjectaltname
      .split(/,\s*/)
      .map((s) => s.replace(/^DNS:/, ''))
      .slice(0, 50);
  return out;
}

/** Connect to host:443 and read the certificate. Never throws; resolves within `timeoutMs`. */
export function readTls(host: string, port = 443, timeoutMs = 8_000): Promise<TlsInfo> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: TlsInfo) => {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      resolve(v);
    };
    const socket = connect({ host, port, servername: host, rejectUnauthorized: false }, () => {
      const cert = socket.getPeerCertificate(false);
      const err = socket.authorizationError;
      finish(
        summariseCert(
          host,
          cert && Object.keys(cert).length ? cert : null,
          socket.authorized,
          err ? String(err) : undefined,
        ),
      );
    });
    socket.setTimeout(timeoutMs, () =>
      finish({ host, authorized: false, error: 'Timed out reading the certificate' }),
    );
    socket.on('error', (e) => finish({ host, authorized: false, error: e.message }));
  });
}
