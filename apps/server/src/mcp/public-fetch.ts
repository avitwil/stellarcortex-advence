// The fetch used for members' MCP servers (DL-056): https only, no redirects, and every address
// the name resolves to must be public. The check runs inside the socket's own DNS lookup, so the
// connection goes to the address that was checked (no DNS rebinding between check and connect).
import { BlockList, isIP } from 'node:net';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { Agent, request } from 'node:https';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';

const blocked = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001:db8::', 32], ['2002::', 16],
  ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) blocked.addSubnet(net, bits, 'ipv6');

/** True when an IP address is on the public internet (not loopback, private, link-local, …). */
export function isPublicAddress(addr: string): boolean {
  const a = addr.replace(/^\[|\]$/g, '').toLowerCase();
  const v = isIP(a);
  if (v === 4) return !blocked.check(a, 'ipv4');
  if (v !== 6) return false;
  // IPv4-mapped and IPv4-compatible forms are judged by their IPv4 address.
  const mapped = /^::(ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(a) ?? null;
  if (mapped) return !blocked.check(mapped[2]!, 'ipv4');
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(a);
  if (hex) {
    const n = (parseInt(hex[1]!, 16) << 16) | parseInt(hex[2]!, 16);
    return !blocked.check([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'), 'ipv4');
  }
  return !blocked.check(a, 'ipv6');
}

type Lookup = (host: string, opts: { all: true }, cb: (err: NodeJS.ErrnoException | null, addrs: LookupAddress[]) => void) => void;

export interface PublicFetchOptions {
  /** DNS resolution (tests replace it) */
  lookup?: Lookup;
  /** which resolved addresses may be used (tests may widen it) */
  allowAddress?: (addr: string) => boolean;
  /** extra trusted CA (tests) */
  ca?: string;
}

export class AddressNotAllowed extends Error {
  code = 'mcp_url_not_allowed';
  constructor(host: string) {
    super(`mcp_url_not_allowed: ${host}`);
  }
}

export function createPublicFetch(o: PublicFetchOptions = {}): typeof fetch {
  const resolve = o.lookup ?? (dnsLookup as unknown as Lookup);
  const allow = o.allowAddress ?? isPublicAddress;
  const checkedLookup = (host: string, opts: { all?: boolean; family?: number }, cb: (...a: unknown[]) => void) => {
    resolve(host, { all: true }, (err, addrs) => {
      if (err) return cb(err);
      const list = (addrs ?? []).filter((x) => !opts.family || x.family === opts.family);
      if (!list.length || list.some((x) => !allow(x.address))) return cb(new AddressNotAllowed(host));
      if (opts.all) cb(null, list);
      else cb(null, list[0]!.address, list[0]!.family);
    });
  };
  const agent = new Agent({ keepAlive: true, maxSockets: 16, ...(o.ca ? { ca: o.ca } : {}) });

  return (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.protocol !== 'https:') throw new AddressNotAllowed(url.host);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    // An address literal is never looked up, so it is checked here.
    if (isIP(host) && !allow(host)) throw new AddressNotAllowed(host);
    const body = req.body ? Buffer.from(await req.arrayBuffer()) : null;
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => {
      headers[k] = v;
    });
    if (body) headers['content-length'] = String(body.length);
    const res = await new Promise<IncomingMessage>((ok, fail) => {
      const r = request(
        { protocol: 'https:', hostname: host, port: url.port || 443, path: `${url.pathname}${url.search}`, method: req.method, headers, agent, lookup: checkedLookup as never, signal: req.signal, servername: isIP(host) ? undefined : host },
        ok,
      );
      r.on('error', fail);
      r.end(body ?? undefined);
    });
    const status = res.statusCode ?? 502;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume();
      throw new TypeError('redirects are not followed for this server');
    }
    const out = new Headers();
    for (const [k, v] of Object.entries(res.headers)) {
      if (Array.isArray(v)) for (const x of v) out.append(k, x);
      else if (v !== undefined) out.set(k, v);
    }
    const empty = status === 204 || status === 205 || status === 304 || req.method === 'HEAD';
    if (empty) res.resume();
    const response = new Response(empty ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), { status, statusText: res.statusMessage, headers: out });
    Object.defineProperty(response, 'url', { value: url.href });
    return response;
  }) as typeof fetch;
}
