/**
 * DNS for AI Discovery (DNS-AID, an IETF draft): agents can find a domain's
 * MCP or A2A endpoints through SVCB/HTTPS records at well-known names such as
 * `_mcp._agents.example.com`. This asks the machine's own DNS resolver (UDP,
 * no third-party DNS-over-HTTPS service) whether any such record exists.
 */
import { createSocket } from 'node:dgram';
import { getServers } from 'node:dns';
import { randomBytes } from 'node:crypto';

/** SVCB = 64, HTTPS = 65, TXT = 16. */
export type RecordType = 64 | 65 | 16;

export const DNS_AID_NAMES = ['_index._agents', '_mcp._agents', '_a2a._agents'] as const;

/** Build a DNS query packet for one name and record type (recursion desired). */
export function buildQuery(name: string, type: RecordType, id = randomBytes(2)): Buffer {
  const header = Buffer.from([id[0]!, id[1]!, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0]);
  const labels = name
    .replace(/\.$/, '')
    .split('.')
    .map((l) => {
      const b = Buffer.from(l, 'ascii');
      return Buffer.concat([Buffer.from([b.length]), b]);
    });
  const tail = Buffer.from([0, 0, type, 0, 1]);
  return Buffer.concat([header, ...labels, tail]);
}

/** Answer count of a DNS response, or -1 when it is an error (NXDOMAIN, SERVFAIL, malformed). */
export function answerCount(resp: Buffer): number {
  if (resp.length < 12) return -1;
  const rcode = resp[3]! & 0x0f;
  if (rcode === 3) return 0; // NXDOMAIN: no such name
  if (rcode !== 0) return -1;
  return resp.readUInt16BE(6);
}

export type DnsQuery = (name: string, type: RecordType) => Promise<number>;

/** Query the first system resolver over UDP. Resolves -1 on timeout or error. */
export const udpQuery: DnsQuery = (name, type) =>
  new Promise((resolve) => {
    const server = getServers().find((s) => /^\d+\.\d+\.\d+\.\d+$/.test(s)) ?? getServers()[0];
    if (!server) return resolve(-1);
    const v6 = server.includes(':');
    const sock = createSocket(v6 ? 'udp6' : 'udp4');
    const id = randomBytes(2);
    let done = false;
    const finish = (n: number) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        sock.close();
      } catch {
        /* closed */
      }
      resolve(n);
    };
    const timer = setTimeout(() => finish(-1), 3_000);
    sock.on('error', () => finish(-1));
    sock.on('message', (msg) => {
      if (msg[0] !== id[0] || msg[1] !== id[1]) return;
      finish(answerCount(msg));
    });
    sock.send(buildQuery(name, type, id), 53, server.replace(/^\[|\]$/g, ''), (err) => {
      if (err) finish(-1);
    });
  });

export interface DnsAidResult {
  checked: string[];
  found: string[];
  /** True when every lookup failed (offline, blocked resolver): inconclusive. */
  failed: boolean;
}

/** Look for DNS-AID records under a host's domain. */
export async function lookupDnsAid(
  host: string,
  query: DnsQuery = udpQuery,
): Promise<DnsAidResult> {
  const domain = host.replace(/^www\./, '').replace(/:\d+$/, '');
  const checked: string[] = [];
  const found: string[] = [];
  let errors = 0;
  const jobs: [string, RecordType][] = [];
  for (const n of DNS_AID_NAMES) jobs.push([`${n}.${domain}`, 64], [`${n}.${domain}`, 65]);
  jobs.push([`_index._agents.${domain}`, 16]);
  await Promise.all(
    jobs.map(async ([name, type]) => {
      checked.push(`${name} ${type === 64 ? 'SVCB' : type === 65 ? 'HTTPS' : 'TXT'}`);
      const n = await query(name, type).catch(() => -1);
      if (n < 0) errors++;
      else if (n > 0) found.push(`${name} ${type === 64 ? 'SVCB' : type === 65 ? 'HTTPS' : 'TXT'}`);
    }),
  );
  return { checked, found, failed: errors === jobs.length };
}
