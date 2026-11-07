// Pinned server keys (NFR-SEC-01, DL-016): host -> SHA-256 of the server's SPKI.
import { X509Certificate, createHash } from 'node:crypto';

export function spkiPinOfPem(pem: string): string {
  return spkiPinOfDer(new X509Certificate(pem).publicKey.export({ type: 'spki', format: 'der' }));
}

export function spkiPinOfDer(spki: Buffer): string {
  return createHash('sha256').update(spki).digest('base64url');
}

export class PinStore {
  private pins = new Map<string, string>();
  /** Returns true when the pin for this host changed. */
  set(host: string, pin: string): boolean {
    const h = hostnameOf(host);
    if (!/^[A-Za-z0-9_-]{43}$/.test(pin)) throw new Error('invalid pin');
    const changed = this.pins.get(h) !== pin;
    this.pins.set(h, pin);
    return changed;
  }
  get(hostname: string): string | undefined {
    return this.pins.get(hostname.replace(/^\[|\]$/g, '').toLowerCase());
  }
}

export function hostnameOf(hostPort: string): string {
  const m = /^\[([^\]]+)\]:\d+$/.exec(hostPort);
  if (m) return m[1]!.toLowerCase();
  return hostPort.replace(/:\d+$/, '').toLowerCase();
}
