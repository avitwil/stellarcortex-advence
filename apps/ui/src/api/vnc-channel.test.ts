// FR-UI-05 live view channel: signed auth first, nothing reaches noVNC before the server says
// ready, RFB bytes round-trip as base64 text, and close is reported once.
import { describe, it, expect } from 'vitest';
import { canonicalFrame, fromB64url, generateDeviceKey, verify, COMPUTER_WS_PATH } from '@advence/protocol';
import { VncChannel, b64ToBytes, bytesToB64 } from './vnc-channel';
import type { ApiClient } from './client';
import type { PlatformBridge, SocketHandlers } from '../platform/types';
import { browserBridge } from '../platform/browser';

describe('FR-UI-05 live view channel', () => {
  it('authenticates with a signed frame, relays base64 RFB bytes and closes once', async () => {
    const key = generateDeviceKey();
    let h!: SocketHandlers;
    let url = '';
    const sent: string[] = [];
    let closed = false;
    const bridge = {
      ...browserBridge(),
      trustServer: async () => undefined,
      socket(u: string, handlers: SocketHandlers) {
        url = u;
        h = handlers;
        return { send: (d: string) => sent.push(d), close: () => void (closed = true) };
      },
    } as PlatformBridge;
    const api = {
      server: { host: 'h:4443', pin: 'x'.repeat(43), deviceId: 'dev_1' },
      token: 'tok',
      ensureSession: async () => undefined,
      secretKey: async () => key.secretKey,
    } as unknown as ApiClient;

    const ch = new VncChannel(api, bridge, 'bot_1');
    // noVNC requires these properties on a raw channel.
    for (const p of ['send', 'close', 'binaryType', 'onerror', 'onmessage', 'onopen', 'protocol', 'readyState']) {
      expect([...Object.keys(ch), ...Object.getOwnPropertyNames(Object.getPrototypeOf(ch))]).toContain(p);
    }
    const got: Uint8Array[] = [];
    let opened = 0;
    const closes: number[] = [];
    ch.onopen = () => opened++;
    ch.onmessage = (e) => got.push(new Uint8Array(e.data));
    ch.onclose = (e) => closes.push(e.code);
    await new Promise((r) => setTimeout(r, 0));
    expect(url).toBe(`wss://h:4443${COMPUTER_WS_PATH}`);

    h.onOpen();
    await new Promise((r) => setTimeout(r, 0));
    const auth = JSON.parse(sent[0]!);
    expect(auth).toMatchObject({ type: 'auth', deviceId: 'dev_1', token: 'tok', botId: 'bot_1' });
    const payload = JSON.stringify({ token: 'tok', botId: 'bot_1' });
    expect(verify(key.publicKey, canonicalFrame({ deviceId: 'dev_1', ts: auth.ts, nonce: auth.nonce, type: 'computer.auth', payload }), fromB64url(auth.sig))).toBe(true);

    // Nothing is sent or delivered before "ready".
    ch.send(new Uint8Array([1, 2, 3]));
    h.onMessage(bytesToB64(new Uint8Array([9])));
    expect(sent.length).toBe(1);
    expect(got.length).toBe(0);

    h.onMessage('{"type":"ready"}');
    expect(opened).toBe(1);
    expect(ch.readyState).toBe('open');
    const big = new Uint8Array(200_000).map((_, i) => i % 251);
    h.onMessage(bytesToB64(big));
    expect(got[0]).toEqual(big);
    ch.send(new Uint8Array([0, 255, 7]));
    expect(b64ToBytes(sent[1]!)).toEqual(new Uint8Array([0, 255, 7]));

    ch.close();
    h.onClose(1000);
    expect(closed).toBe(true);
    expect(closes).toEqual([1000]);
    expect(ch.readyState).toBe('closed');
  });
});
