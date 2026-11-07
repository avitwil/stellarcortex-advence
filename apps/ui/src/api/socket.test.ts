import { describe, it, expect, vi, afterEach } from 'vitest';
import { generateDeviceKey, pairingCode, toB64url, randomBytes, HEARTBEAT_DEAD_MS } from '@advence/protocol';
import { ReconnectingSocket } from './socket';
import { ApiClient } from './client';
import type { PlatformBridge, SocketHandlers } from '../platform/types';
import { browserBridge } from '../platform/browser';

afterEach(() => vi.useRealTimers());

function fakeBridge() {
  const opened: { h: SocketHandlers; closed: boolean; sent: string[] }[] = [];
  const bridge = {
    ...browserBridge(),
    trustServer: async () => undefined,
    socket(_url: string, h: SocketHandlers) {
      const s = { h, closed: false, sent: [] as string[] };
      opened.push(s);
      return { send: (d: string) => s.sent.push(d), close: () => void (s.closed = true) };
    },
  } as PlatformBridge;
  return { bridge, opened };
}

describe('NFR-REL-01 client socket', () => {
  it('a dead stream is replaced by exactly one new connection, and late events from the old one are ignored', async () => {
    vi.useFakeTimers();
    let now = 1_000_000;
    const { bridge, opened } = fakeBridge();
    const key = generateDeviceKey();
    const api = {
      server: { host: 'h:4443', pin: 'x'.repeat(43), deviceId: 'dev_1' },
      token: 't',
      ensureSession: async () => undefined,
      secretKey: async () => key.secretKey,
      refresh: async () => undefined,
    } as unknown as ApiClient;
    const sock = new ReconnectingSocket(api, bridge, () => now);
    await vi.advanceTimersByTimeAsync(0);
    expect(opened.length).toBe(1);
    const events: string[] = [];
    sock.onEvent((e) => events.push(e));
    opened[0]!.h.onOpen();
    opened[0]!.h.onMessage(JSON.stringify({ type: 'ready', sessionExpiresAt: now + 900_000 }));
    expect(sock.state).toBe('open');
    now += HEARTBEAT_DEAD_MS + 1;
    sock.check();
    expect(opened[0]!.closed).toBe(true);
    // The old socket's close arrives late: it must not trigger a second reconnect.
    opened[0]!.h.onClose(1006);
    opened[0]!.h.onMessage(JSON.stringify({ type: 'event', event: 'stale', data: null }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(opened.length).toBe(2);
    expect(events).toEqual([]);
    sock.stop();
  });
});

describe('FR-CLI-03 pairing code', () => {
  it('the client computes the code from the link pin and its own key, ignoring the server value', async () => {
    const pin = toB64url(randomBytes(32));
    const bridge = {
      ...browserBridge(),
      trustServer: async () => undefined,
      loadSecret: async () => null,
      saveSecret: async () => undefined,
      http: async () => ({ status: 200, body: JSON.stringify({ pairingId: 'pr_1', deviceId: 'dev_1', code: '000000' }) }),
    } as PlatformBridge;
    const c = new ApiClient({ id: 's1', host: 'h:4443', pin, name: 'n' } as never, bridge);
    const r = await c.startPairing('tok', 'dev', 'linux');
    const pub = await c.publicKey();
    const { fromB64url } = await import('@advence/protocol');
    expect(r.code).toBe(pairingCode(pin, fromB64url(pub), 'pr_1'));
    expect(r.code).not.toBe('000000');
  });
});
