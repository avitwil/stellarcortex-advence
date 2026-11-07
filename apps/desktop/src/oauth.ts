// Loopback receiver for desktop Google sign-in (D-13, DL-006): listens on
// localhost:47823 only for the duration of one sign-in.
import http from 'node:http';

export const LOOPBACK_PORT = 47823;

export function waitForOAuthCode(opts: { timeoutMs?: number; port?: number; page?: string } = {}): { ready: Promise<void>; result: Promise<{ code: string; state: string }>; cancel(): void } {
  let server: http.Server;
  let timer: NodeJS.Timeout;
  let readyResolve!: () => void;
  let readyReject!: (e: Error) => void;
  const ready = new Promise<void>((res, rej) => {
    readyResolve = res;
    readyReject = rej;
  });
  let rejectResult!: (e: Error) => void;
  const result = new Promise<{ code: string; state: string }>((resolve, reject) => {
    rejectResult = reject;
    server = http.createServer((req, res) => {
      const u = new URL(req.url ?? '/', `http://localhost:${LOOPBACK_PORT}`);
      if (u.pathname !== '/oauth/callback') {
        res.writeHead(404).end();
        return;
      }
      const code = u.searchParams.get('code');
      const state = u.searchParams.get('state');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'", 'cache-control': 'no-store' });
      res.end(opts.page ?? '<!doctype html><meta charset="utf-8"><title>StellarCortex Advence</title><body style="font-family:system-ui;padding:40px">You can close this tab and return to StellarCortex Advence.</body>');
      clearTimeout(timer);
      server.close();
      if (code && state) resolve({ code, state });
      else reject(new Error(u.searchParams.get('error') ?? 'no code'));
    });
    server.on('error', (e) => {
      readyReject(e);
      reject(e);
    });
    server.listen(opts.port ?? LOOPBACK_PORT, '127.0.0.1', () => readyResolve());
    timer = setTimeout(() => {
      server.close();
      reject(new Error('timeout'));
    }, opts.timeoutMs ?? 5 * 60_000);
  });
  // Callers may only await `ready`; a failure is still reported through `result`.
  result.catch(() => undefined);
  return {
    ready,
    result,
    cancel() {
      clearTimeout(timer);
      server?.close();
      rejectResult(new Error('cancelled'));
    },
  };
}
