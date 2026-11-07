// Pinned server keys (NFR-SEC-01, DL-016): host -> SHA-256 of the server's SPKI.
import { X509Certificate, createHash } from 'node:crypto';

export function spkiPinOfPem(pem: string): string {
  return spkiPinOfDer(new X509Certificate(pem).publicKey.export({ type: 'spki', format: 'der' }));
}

export function spkiPinOfDer(spki: Buffer): string {
  return createHash('sha256').update(spki).digest('base64url');
}

/** One pin per server endpoint (host and port), so two servers on one machine do not collide. */
export class PinStore {
  private pins = new Map<string, string>();
  /** Returns true when the pin for this endpoint changed. */
  set(hostPort: string, pin: string): boolean {
    const k = endpointKey(hostPort);
    if (!/^[A-Za-z0-9_-]{43}$/.test(pin)) throw new Error('invalid pin');
    const changed = this.pins.get(k) !== pin;
    this.pins.set(k, pin);
    return changed;
  }
  get(hostPort: string): string | undefined {
    return this.pins.get(endpointKey(hostPort));
  }
}

/** Normalizes "host", "host:port" or "[v6]:port" to "host:port" (default port 443). */
export function endpointKey(hostPort: string): string {
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(hostPort);
  const m = v6 ?? /^([^:[\]]+)(?::(\d+))?$/.exec(hostPort);
  if (!m) throw new Error('invalid host');
  return `${m[1]!.toLowerCase()}:${m[2] ?? '443'}`;
}

export function hostnameOf(hostPort: string): string {
  const m = /^\[([^\]]+)\]:\d+$/.exec(hostPort);
  if (m) return m[1]!.toLowerCase();
  return hostPort.replace(/:\d+$/, '').toLowerCase();
}
