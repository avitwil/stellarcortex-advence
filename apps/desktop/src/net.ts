// Pinned networking in the main process (NFR-SEC-01, DL-016). The renderer never opens
// network connections itself (CSP connect-src 'self'); it asks the main process, which
// connects only to paired hosts and only when the server key matches the pin.
import https from 'node:https';
import tls from 'node:tls';
import type { Duplex } from 'node:stream';
import WebSocket from 'ws';
import { PinStore, hostnameOf, spkiPinOfDer } from './pin';

const MAX_BODY = 60 * 1024 * 1024;

export class PinnedAgent extends https.Agent {
  constructor(private pin: string) {
    super({ keepAlive: true, maxCachedSessions: 0 });
  }
  override createConnection(options: https.RequestOptions, cb?: (err: Error | null, s: Duplex) => void): undefined {
    const s = tls.connect({ ...(options as tls.ConnectionOptions), rejectUnauthorized: false, minVersion: 'TLSv1.3', servername: undefined });
    s.once('secureConnect', () => {
      const cert = s.getPeerX509Certificate();
      const got = cert ? spkiPinOfDer(cert.publicKey.export({ type: 'spki', format: 'der' })) : '';
      if (got !== this.pin) {
        s.destroy();
        cb?.(new Error('pin_mismatch'), s);
        return;
      }
      cb?.(null, s);
    });
    s.once('error', (e) => cb?.(e, s));
    return undefined;
  }
}

export class PinnedNet {
  private agents = new Map<string, PinnedAgent>();
  private sockets = new Map<string, WebSocket>();
  constructor(private pins: PinStore) {}

  private agentFor(hostPort: string): PinnedAgent {
    const pin = this.pins.get(hostnameOf(hostPort));
    if (!pin) throw new Error('untrusted_host');
    const key = `${hostPort}#${pin}`;
    let a = this.agents.get(key);
    if (!a) {
      a = new PinnedAgent(pin);
      this.agents.set(key, a);
    }
    return a;
  }

  private target(url: string, proto: 'https:' | 'wss:'): URL {
    const u = new URL(url);
    if (u.protocol !== proto) throw new Error('bad_protocol');
    return u;
  }

  request(req: { url: string; method: string; headers: Record<string, string>; body?: string }): Promise<{ status: number; body: string }> {
    const u = this.target(req.url, 'https:');
    const agent = this.agentFor(u.host);
    return new Promise((resolve, reject) => {
      const r = https.request({ method: req.method, hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, headers: req.headers, agent, timeout: 60_000 }, (res) => {
        const chunks: Buffer[] = [];
        let n = 0;
        res.on('data', (c: Buffer) => {
          n += c.length;
          if (n > MAX_BODY) r.destroy(new Error('response_too_large'));
          else chunks.push(c);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      });
      r.on('timeout', () => r.destroy(new Error('timeout')));
      r.on('error', reject);
      if (req.body) r.write(req.body);
      r.end();
    });
  }

  wsOpen(id: string, url: string, emit: (e: { id: string; kind: 'open' | 'message' | 'close'; data?: string; code?: number }) => void): void {
    const u = this.target(url, 'wss:');
    const ws = new WebSocket(u, { agent: this.agentFor(u.host), maxPayload: 8 * 1024 * 1024 });
    this.sockets.set(id, ws);
    ws.on('open', () => emit({ id, kind: 'open' }));
    ws.on('message', (d) => emit({ id, kind: 'message', data: d.toString() }));
    ws.on('close', (code) => {
      this.sockets.delete(id);
      emit({ id, kind: 'close', code });
    });
    ws.on('error', () => undefined);
  }

  wsSend(id: string, data: string): void {
    const ws = this.sockets.get(id);
    if (ws?.readyState === WebSocket.OPEN) ws.send(data);
  }

  wsClose(id: string): void {
    this.sockets.get(id)?.close();
  }

  closeAll(): void {
    for (const ws of this.sockets.values()) ws.terminate();
    this.sockets.clear();
    for (const a of this.agents.values()) a.destroy();
    this.agents.clear();
  }
}
